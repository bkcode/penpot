import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { McpProbe } from "./McpProbe.ts";

for (const ending of ["\n", "\r\n"]) {
    test(`reads a file through initialize and fragmented SSE (${JSON.stringify(ending)})`, async () => {
        let initialized = false;
        const server = createServer(async (request, response) => {
            if (request.method === "DELETE") {
                response.writeHead(204).end();
                return;
            }
            let body = "";
            for await (const data of request) {
                body += data;
            }
            const rpc = JSON.parse(body);
            if (rpc.method === "initialize") {
                response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" });
                response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05" } }));
            } else if (rpc.method === "notifications/initialized") {
                initialized = true;
                response.writeHead(202).end();
            } else {
                assert.equal(initialized, true);
                assert.equal(request.headers["mcp-session-id"], "test-session");
                assert.equal(rpc.params.name, "execute_code");
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                const result = {
                    content: [{ type: "text", text: JSON.stringify({ result: { fileId: "file", pageId: "page" } }) }],
                };
                const event = `event: message${ending}data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}${ending}${ending}`;
                const split = event.indexOf(ending) + 1;
                response.write(event.slice(0, split));
                setImmediate(() => response.end(event.slice(split)));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const probe = new McpProbe(`http://127.0.0.1:${address.port}/mcp`);
        try {
            assert.deepEqual(await probe.readFile(), { fileId: "file", pageId: "page" });
        } finally {
            await probe.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}
