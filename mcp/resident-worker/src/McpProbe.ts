/** A bounded read-only MCP client used to verify the actual execution context. */
export class McpProbe {
    static readonly CONTEXT_CODE = "return { fileId: penpot.currentFile.id, pageId: penpot.currentPage.id };";
    private readonly url: string;
    private sessionId: string | null = null;
    private protocolVersion = "2024-11-05";
    private requestId = 0;

    constructor(url: string) {
        this.url = url;
    }

    async readFile(): Promise<{ fileId: string; pageId: string }> {
        if (!this.sessionId) {
            const initialized = await this.rpc("initialize", {
                protocolVersion: this.protocolVersion,
                capabilities: {},
                clientInfo: { name: "penpot-resident-worker", version: "0.1.0" },
            });
            this.protocolVersion = initialized.protocolVersion;
            await this.rpc("notifications/initialized", undefined, true);
        }
        const response = await this.rpc("tools/call", {
            name: "execute_code",
            arguments: { code: McpProbe.CONTEXT_CODE },
        });
        if (response.isError) {
            throw new Error("MCP execution context unavailable");
        }
        const text = response.content?.find((item: { type: string }) => item.type === "text")?.text;
        const result = JSON.parse(text).result;
        if (typeof result?.fileId !== "string" || typeof result?.pageId !== "string") {
            throw new Error("MCP execution context invalid");
        }
        return result;
    }

    async close(): Promise<void> {
        if (this.sessionId) {
            await fetch(this.url, {
                method: "DELETE",
                headers: { "Mcp-Session-Id": this.sessionId },
                signal: AbortSignal.timeout(3000),
            }).catch(() => undefined);
        }
        this.sessionId = null;
    }

    private async rpc(method: string, params?: unknown, notification = false): Promise<any> {
        const id = ++this.requestId;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        };
        if (this.sessionId) {
            headers["Mcp-Session-Id"] = this.sessionId;
            headers["MCP-Protocol-Version"] = this.protocolVersion;
        }
        const response = await fetch(this.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            this.sessionId = null;
            throw new Error(`MCP HTTP status ${response.status}`);
        }
        this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
        if (notification) {
            await response.body?.cancel();
            return {};
        }
        let payload;
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
            payload = await this.readEvent(response, id);
        } else {
            payload = await response.json();
        }
        if (payload.error) {
            throw new Error("MCP request failed");
        }
        return payload.result;
    }

    private async readEvent(response: Response, id: number): Promise<any> {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let bytes = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                bytes += value.length;
                if (bytes > 1024 * 1024) {
                    throw new Error("MCP probe response too large");
                }
                buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const event = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const data = event
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    if (data) {
                        const item = JSON.parse(data);
                        if (item.id === id) {
                            return item;
                        }
                    }
                }
            }
            throw new Error("MCP probe returned no matching result");
        } finally {
            await reader.cancel().catch(() => undefined);
        }
    }
}
