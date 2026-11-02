/** Keeps the worker on its private origin while resolving this instance's canonical asset URLs. */
export class OriginPolicy {
    private readonly internalOrigin: string;
    private publicOrigin: string;

    constructor(internalOrigin: string) {
        this.internalOrigin = new URL(internalOrigin).origin;
        this.publicOrigin = this.internalOrigin;
    }

    rewriteConfiguration(source: string): string {
        const match = source.match(/(?:^|\n)\s*var penpotPublicURI\s*=\s*("[^"\n]*")\s*;/);
        if (match) {
            const origin = new URL(JSON.parse(match[1]));
            if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
                throw new Error("Invalid canonical Penpot origin");
            }
            this.publicOrigin = origin.origin;
        }
        return `${source}\nvar penpotPublicURI = ${JSON.stringify(this.internalOrigin)};\n`;
    }

    assetUrl(requestUrl: string): string | null {
        const requested = new URL(requestUrl);
        if (
            ![this.publicOrigin, this.internalOrigin].includes(requested.origin) ||
            !requested.pathname.startsWith("/assets/") ||
            requested.username ||
            requested.password
        ) {
            return null;
        }
        return `${this.internalOrigin}${requested.pathname}${requested.search}`;
    }
}
