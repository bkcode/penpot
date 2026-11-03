import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ArchiveDownload } from "./ArchiveDownload.ts";
import { ImportJobs, type ImportRequest } from "./ImportJobs.ts";
import { PenpotImportBackend } from "./PenpotImportBackend.ts";

const credentials = JSON.parse(
    readFileSync(process.env.PENPOT_IMPORT_CREDENTIALS_FILE ?? "/run/secrets/worker-credentials", "utf8")
);
if (
    ![credentials.email, credentials.password, credentials.mcpKey].every(
        (value) => typeof value === "string" && value.length > 0
    )
)
    throw new Error("invalid_import_credentials");
const teamId = process.env.PENPOT_IMPORT_TEAM_ID;
if (!teamId || !/^[0-9a-f-]{36}$/i.test(teamId)) throw new Error("invalid_import_team_id");
const backend = new PenpotImportBackend(
    process.env.PENPOT_IMPORT_BASE_URL ?? "http://penpot-frontend:8080",
    credentials,
    teamId
);
const jobs = new ImportJobs(process.env.PENPOT_IMPORT_JOBS_DIR ?? "/data/jobs", backend, new ArchiveDownload());
await jobs.initialize();

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const server = createServer(async (request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (path === "/healthz" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
        return;
    }
    if (path !== "/mcp") {
        response.writeHead(404).end();
        return;
    }
    const bearer = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const supplied = Buffer.from(bearer);
    const expected = Buffer.from(credentials.mcpKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.headers.origin) {
        response.writeHead(401, { "Cache-Control": "no-store" }).end();
        return;
    }
    if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" }).end();
        return;
    }
    const mcp = new Server({ name: "penpot-file-import", version: "0.1.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "import_penpot_file",
                description:
                    "Import a public HTTPS .penpot archive into the configured resident account's team. Defaults to that team's Drafts project. Returns an asynchronous jobId; poll get_import_status. Supply one UUID requestId per intentional import and reuse it on retries to prevent duplicate imports. Never retry failed or interrupted imports with a new requestId before checking the project. Does not open the imported file or switch the resident editor. Supports archives up to 200 MiB.",
                inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["url", "requestId"],
                    properties: {
                        url: { type: "string", format: "uri", maxLength: 8192 },
                        requestId: { type: "string", format: "uuid" },
                        projectId: {
                            type: "string",
                            format: "uuid",
                            description: "Optional destination project in the configured team.",
                        },
                        name: { type: "string", minLength: 1, maxLength: 250 },
                    },
                },
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            },
            {
                name: "get_import_status",
                description:
                    "Read the persistent status and imported file IDs of a Penpot import job. Importing/completed/failed/interrupted are distinct; interruption does not confirm rollback. Source URLs and credentials are not returned.",
                inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["jobId"],
                    properties: { jobId: { type: "string", format: "uuid" } },
                },
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            },
        ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        try {
            const args = params.arguments ?? {};
            if (params.name === "import_penpot_file") {
                if (
                    typeof args.url !== "string" ||
                    args.url.length > 8192 ||
                    typeof args.requestId !== "string" ||
                    (args.projectId !== undefined && typeof args.projectId !== "string") ||
                    (args.name !== undefined && typeof args.name !== "string")
                )
                    throw new Error("invalid_import_arguments");
                return text(await jobs.start(args as unknown as ImportRequest));
            }
            if (params.name === "get_import_status" && typeof args.jobId === "string")
                return text(jobs.get(args.jobId));
            throw new Error("invalid_import_tool_or_arguments");
        } catch (error) {
            const code =
                error instanceof Error && /^(invalid_|archive_|request_|import_)[a-z0-9_]+$/.test(error.message)
                    ? error.message
                    : "import_request_failed";
            return { ...text({ error: code }), isError: true };
        }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => {
        void transport.close();
        void mcp.close();
    });
    try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
    } catch {
        if (!response.headersSent) response.writeHead(500).end();
    }
});
server.listen(4405, "0.0.0.0", () =>
    console.error("Penpot import MCP listening on 4405; resident account and team only")
);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
        server.close();
        // In-flight outcomes remain marked in persistent jobs and are not restarted automatically.
        setTimeout(() => process.exit(0), 1000).unref();
    });
}
