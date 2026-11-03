import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { request } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ipaddr from "ipaddr.js";

export interface AddressResolver {
    resolve(hostname: string): Promise<{ address: string; family: number }[]>;
}

export class PublicDnsResolver implements AddressResolver {
    async resolve(hostname: string): Promise<{ address: string; family: number }[]> {
        return lookup(hostname, { all: true, verbatim: true });
    }
}

/** Downloads bounded HTTPS archives without forwarding instance credentials. */
export class ArchiveDownload {
    static readonly MAX_BYTES = 200 * 1024 * 1024;

    private readonly resolver: AddressResolver;
    constructor(resolver: AddressResolver = new PublicDnsResolver()) {
        this.resolver = resolver;
    }

    static validateUrl(value: string): URL {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            throw new Error("invalid_archive_url");
        }
        if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
            throw new Error("archive_requires_https_without_credentials");
        }
        return url;
    }

    async publicAddresses(url: URL): Promise<{ address: string; family: number }[]> {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = ipaddr.isValid(host)
            ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }]
            : await this.resolver.resolve(host);
        if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast")) {
            throw new Error("ssrf_blocked_archive_target");
        }
        return addresses;
    }

    async download(value: string, destination: string): Promise<number> {
        let url = ArchiveDownload.validateUrl(value);
        const signal = AbortSignal.timeout(60_000);
        for (let redirects = 0; redirects <= 5; redirects++) {
            const addresses = await this.publicAddresses(url);
            if (signal.aborted) throw new Error("archive_download_timeout");
            const address = addresses[0];
            const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
                const req = request(
                    url,
                    {
                        signal,
                        // Pin the checked address so DNS cannot change between validation and connection.
                        lookup: (_host, options, callback) => {
                            if (options.all) callback(null, [address]);
                            else callback(null, address.address, address.family);
                        },
                        headers: { Accept: "application/octet-stream, application/zip" },
                    },
                    resolve
                );
                req.once("error", () => reject(new Error("archive_download_failed")));
                req.end();
            });
            if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                if (!response.headers.location || redirects === 5) throw new Error("archive_redirect_limit");
                url = ArchiveDownload.validateUrl(new URL(response.headers.location, url).href);
                continue;
            }
            if (response.statusCode !== 200) {
                response.resume();
                throw new Error(`archive_http_${response.statusCode ?? "unknown"}`);
            }
            if (Number(response.headers["content-length"]) > ArchiveDownload.MAX_BYTES) {
                response.destroy();
                throw new Error("archive_too_large");
            }
            let bytes = 0;
            const limit = new Transform({
                transform(chunk, _encoding, done) {
                    bytes += chunk.length;
                    done(bytes > ArchiveDownload.MAX_BYTES ? new Error("archive_too_large") : null, chunk);
                },
            });
            await pipeline(response, limit, createWriteStream(destination, { mode: 0o600 }), { signal });
            if (bytes < 4) throw new Error("archive_empty_or_invalid");
            return bytes;
        }
        throw new Error("archive_redirect_limit");
    }
}
