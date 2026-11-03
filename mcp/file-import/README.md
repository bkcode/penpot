# Penpot file import MCP

A separate production import endpoint for the configured resident account and team. It runs alongside the existing multi-user design MCP without development mode, frontend nREPL, browser DOM automation, or broader plugin permissions. The development `import_penpot_file` tool remains unchanged.

## Deployment

The root Compose deployment includes `penpot-import`. It uses the same ignored `.worker-credentials.json` as the resident worker, with a read-only secret mount. The public download resolver is the existing private DNS-over-HTTPS service. Only loopback `127.0.0.1:9002` is published.

```bash
docker compose up -d --build penpot-import
docker compose logs --tail=50 penpot-import
```

MCP endpoint: `http://localhost:9002/mcp`. Supply `Authorization: Bearer <worker MCP Key>`. Anonymous requests, other keys and browser-origin requests are rejected. The accepted key selects the one configured worker account; this endpoint does not impersonate arbitrary MCP users. Backend login and ordinary project permissions still apply. The service cannot import to another team.

The service's dedicated login session does not take over the resident editor. Imported files are not automatically opened, connected as libraries, or merged into the open design.

## Tools

`import_penpot_file`:

```json
{
  "url": "https://example.com/design-library.penpot",
  "requestId": "YOUR_NEW_UUID",
  "projectId": "OPTIONAL_PROJECT_UUID_IN_THE_CONFIGURED_TEAM",
  "name": "Optional imported name"
}
```

Only HTTPS on the default port is accepted. URL credentials and fragments are rejected. Downloads are limited to 200 MiB and 60 seconds, with at most five redirects. All resolved addresses and every redirect target must be public unicast addresses, including IPv4-mapped IPv6 validation. Connections pin a checked address; cookies and tokens are never sent to archive hosts. Archives are sent through the normal authenticated `import-binfile` multipart endpoint; backend archive validation remains in force.

`projectId` defaults to the configured team's Drafts project. Each intentional import needs one UUID `requestId`. Reusing it with the same input returns the existing job, including after a service restart. Reusing it with different input fails. One import runs at a time.

`get_import_status`:

```json
{ "jobId": "THE_REQUEST_UUID" }
```

States are `preparing`, `downloading`, `importing`, `completed`, `failed` and `interrupted`. Success returns imported file IDs, names, project ID and team ID. Imports run outside the MCP request deadline; poll status rather than repeat the start request.

An interrupted or unconfirmed import may already have created files. Check the destination project before making a new request ID. Startup marks in-flight jobs interrupted and does not replay them. Jobs persist in `penpot_penpot_import_jobs`; URL hashes are retained for deduplication, but source URLs and credentials are not recorded. The service retains at most 1,000 jobs and rejects new jobs when full; it does not silently discard deduplication history. Download files live in temporary storage and are removed after a job. Backend imports have a ten-minute request timeout; a timeout does not prove rollback.

## Client configuration

For Codex, add a separate server to the user config, preserving the existing `penpot` server:

```toml
[mcp_servers.penpot_import]
url = "http://localhost:9002/mcp"
http_headers = { Authorization = "Bearer YOUR_WORKER_MCP_KEY" }
startup_timeout_sec = 20
tool_timeout_sec = 30
```

Keep actual credentials out of Git. Reload MCP connections or restart the client to discover the new tools. Other clients, including a local model's MCP host, can use the same HTTP endpoint and authorization header.

## Development

This package has its own lockfile and does not change the upstream MCP/plugin dependency graph. Use Node 24+.

```bash
pnpm install --ignore-workspace --frozen-lockfile
pnpm run test
pnpm run types:check
pnpm run fmt:check
pnpm run build
```

Tests cover public/private DNS and IP checks, unsupported URL schemes, persistent idempotency, concurrent imports, restart behavior, temporary-file cleanup, error redaction, fragmented SSE and both old/new Transit result formats. For live acceptance, import an official public archive into a disposable project, verify its file summary, repeat the same request ID and confirm no duplicate, then delete the test project.
