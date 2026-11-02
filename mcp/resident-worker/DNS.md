# Remote image DNS repair

A Fake-IP proxy can make public image domains resolve to `198.18.0.0/15`. Penpot correctly rejects that reserved range before downloading the image. Plain DNS requests to public resolvers may also be intercepted.

The optional `compose.dns.yaml` overlay supplies the backend with real DNS answers using AdGuard's version-pinned DNS-over-HTTPS proxy. No backend patch, host allowlist, SSRF bypass, or permanent image-IP mapping is used. The existing download validation and redirect checks remain in force.

## Deployment

Merge this overlay with the existing Penpot deployment. It adds a private Docker network and one DNS service. No DNS port is published on the host. Only `penpot-backend` uses this resolver; Docker still resolves Penpot service names through its embedded resolver.

```bash
docker compose -p penpot \
  -f /path/to/deployment/compose.yaml \
  -f /path/to/deployment/compose.override.yaml \
  -f /path/to/penpot/mcp/resident-worker/compose.dns.yaml \
  up -d
```

The default subnet is `172.30.250.0/24`, with the resolver at `172.30.250.53`. Check for conflicts with Docker networks, LANs, and VPN routes before enabling. Set `PENPOT_DNS_SUBNET` and `PENPOT_DNS_ADDRESS` together if these overlap another network. The worker overlay can be merged alongside this file.

Upstreams are `https://1.1.1.1/dns-query` and `https://1.0.0.1/dns-query`. Literal IPs avoid a DNS bootstrap dependency, TLS certificates are verified, and port 443 avoids ordinary UDP DNS interception. DNS cache TTL is capped at 300 seconds. The upstreams receive the backend's public DNS queries. Do not enable this overlay in an environment that requires an organizational resolver; configure the proxy's HTTPS upstream accordingly instead.

## Verification

1. Confirm a public image hostname resolves to public addresses inside the backend.
2. Confirm `penpot-postgres`, `penpot-valkey` and other internal names still resolve.
3. Import a known public PNG through the normal URL-import RPC (`create-file-media-object-from-url`, used by `penpot.uploadMediaUrl`) and verify returned dimensions and MIME type. Then test the original URL separately: a remote 403/404 is a source-access failure, not a DNS or SSRF failure.
4. Confirm localhost, metadata IPs, and `198.18.0.0/15` targets still return `ssrf-blocked-target`.
5. Upload a local PNG through `upload-file-media-object`, read `/assets/by-file-media-id/{id}`, and compare its bytes with the source. This is the multipart endpoint used by `penpot.uploadMediaData`.
6. If the image endpoint redirects, Penpot continues validating every redirect target.

Changing DNS requires recreating the backend container and clears its old JVM DNS cache. Do this between editing tasks; do not discard data volumes. To roll back, remove the DNS overlay from the merged configuration and recreate the backend. Existing media and files are unchanged.

## Error URI

The frontend's `app.main.repo/handle-response` adds the RPC URL as `:uri` to an error map. Consequently an `uploadMediaUrl` error may name `/api/main/methods/create-file-media-object-from-url` even when the backend rejected the external image host. Inspect the original HTTP response body when diagnosing; an internal RPC URL in the wrapped error is not proof of an SSRF check on that internal endpoint.

## Sources

- https://github.com/AdguardTeam/dnsproxy
- `backend/src/app/util/ssrf.clj`
- `backend/src/app/http/client.clj`
- `backend/src/app/media.clj`

## Source access failures

DNS repair cannot make an image server grant access to a URL it rejects. If a known public image imports but a specific source returns 403, use an authorized local copy of that asset or a working public source URL. For plugin code, use `penpot.uploadMediaData(name, bytes, mimeType)` with a `Uint8Array` containing the local image bytes. A plugin cannot read an arbitrary host filesystem path; the MCP client must read and supply those bytes. Do not pass a local path to `uploadMediaUrl`, and do not disable SSRF checks for this case.
