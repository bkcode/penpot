import assert from "node:assert/strict";
import { test } from "node:test";
import transit from "transit-js";
import { PenpotImportBackend } from "./PenpotImportBackend.ts";

for (const newline of ["\n", "\r\n"]) {
    test("decodes fragmented import completion with Transit UUID sets " + JSON.stringify(newline), async () => {
        const id = "00000000-0000-4000-8000-000000000001";
        const data = transit
            .writer("json-verbose")
            .write(transit.map([transit.keyword("file-ids"), transit.set([transit.uuid(id)])]));
        const wire = `event: progress${newline}data: {}${newline}${newline}event: end${newline}data: ${data}${newline}${newline}`;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const part of wire.match(/.{1,9}|\n/g) ?? []) controller.enqueue(new TextEncoder().encode(part));
                controller.close();
            },
        });
        const result = await PenpotImportBackend.readImportResult(new Response(body));
        assert.ok(!Array.isArray(result));
        assert.deepEqual(result["file-ids"], [id]);
    });
}
test("does not confuse progress or a backend SSE error with successful import", async () => {
    await assert.rejects(
        PenpotImportBackend.readImportResult(new Response("event: progress\ndata: {}\n\n")),
        /unconfirmed/
    );
    await assert.rejects(
        PenpotImportBackend.readImportResult(new Response('event: error\ndata: {"secret":"must-not-leak"}\n\n')),
        (error: unknown) =>
            error instanceof Error && !error.message.includes("secret") && error.message.includes("rejected")
    );
});
test("backend URI cannot carry credentials or change paths", () => {
    for (const url of ["https://user:secret@example.com/", "https://example.com/private", "file:///etc/passwd"]) {
        assert.throws(() => new PenpotImportBackend(url, { email: "worker", password: "secret" }, "team"));
    }
});

test("decodes the UUID set returned by Penpot 2.18.5 imports", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const data = transit.writer("json-verbose").write(transit.set([transit.uuid(id)]));
    assert.deepEqual(await PenpotImportBackend.readImportResult(new Response(`event: end\ndata: ${data}\n\n`)), [id]);
});

test("login forwards only email and password, never the import MCP token", async (t) => {
    const requests: { method: string; body: any }[] = [];
    t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
        const method = url.pathname.split("/").at(-1)!;
        const body = JSON.parse(String(options.body));
        requests.push({ method, body });
        if (method === "login-with-password")
            return new Response("{}", { headers: { "Set-Cookie": "session=local; HttpOnly" } });
        return new Response(JSON.stringify([{ id: "drafts", isDefault: true }]));
    });
    const credentials = { email: "worker@example.test", password: "private-password", mcpKey: "private-mcp-key" };
    const backend = new PenpotImportBackend("http://penpot.test", credentials, "team");
    assert.equal(await backend.prepare(), "drafts");
    assert.deepEqual(requests[0].body, { email: credentials.email, password: credentials.password });
});
