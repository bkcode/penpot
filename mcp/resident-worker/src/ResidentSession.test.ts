import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { McpProbe } from "./McpProbe.ts";
import { ResidentSession } from "./ResidentSession.ts";
import { SessionHealthError } from "./SessionHealth.ts";
import type { WorkerConfig } from "./WorkerConfig.ts";

class TestPage extends EventEmitter {
    closed = false;
    isClosed(): boolean {
        return this.closed;
    }
    setDefaultTimeout(): void {}
    async goto(): Promise<void> {}
    getByRole() {
        return { waitFor: async () => undefined };
    }
}

class TestBrowser {
    readonly page = new TestPage();
    isConnected(): boolean {
        return true;
    }
    async newContext() {
        return {
            route: async () => undefined,
            request: { post: async () => ({ ok: () => true }) },
            newPage: async () => this.page,
            close: async () => undefined,
        };
    }
    async close(): Promise<void> {}
}

const config = {
    baseUrl: "http://penpot.test",
    mcpUrl: "http://penpot.test/mcp/stream",
    workspaceUrl: "http://penpot.test/#/workspace",
    fileId: "test-file",
    credentials: { email: "worker@example.test", password: "not-a-secret" },
    startupTimeoutMs: 1000,
    taskBudgetMs: 150000,
} as WorkerConfig;

function pluginConnected(page: TestPage): void {
    const socket = new EventEmitter() as EventEmitter & { url: () => string };
    socket.url = () => "http://penpot.test/mcp/ws";
    page.emit("websocket", socket);
    socket.emit("framesent", { payload: JSON.stringify({ type: "heartbeat" }) });
}

function browserUnavailable(error: unknown): boolean {
    return error instanceof SessionHealthError && error.reason === "browser_unavailable";
}

test("a renderer crash is browser loss even when the browser and page stay open", async (t) => {
    const browser = new TestBrowser();
    t.mock.method(chromium, "launch", async () => browser as unknown as Browser);
    t.mock.method(McpProbe.prototype, "readFile", async () => ({
        fileId: config.fileId,
        pageId: "page",
    }));
    const session = new ResidentSession(config);
    try {
        await session.connect();
        pluginConnected(browser.page);
        assert.equal((await session.check()).state, "verified");
        browser.page.emit("crash");
        await assert.rejects(session.check(), browserUnavailable);
    } finally {
        await session.close();
    }
});

test("a crash during a pending probe is classified as browser loss", async (t) => {
    const browser = new TestBrowser();
    t.mock.method(chromium, "launch", async () => browser as unknown as Browser);
    t.mock.method(McpProbe.prototype, "readFile", async () => ({
        fileId: config.fileId,
        pageId: "page",
    }));
    const session = new ResidentSession(config);
    try {
        await session.connect();
        pluginConnected(browser.page);
        let failProbe!: (error: Error) => void;
        t.mock.method(
            McpProbe.prototype,
            "readFile",
            () =>
                new Promise((_, reject) => {
                    failProbe = reject;
                })
        );
        const checked = session.check();
        browser.page.emit("crash");
        failProbe(new Error("probe failed"));
        await assert.rejects(checked, browserUnavailable);
    } finally {
        await session.close();
    }
});

test("reconnecting replaces a crashed page with a healthy session", async (t) => {
    let browser = new TestBrowser();
    t.mock.method(chromium, "launch", async () => browser as unknown as Browser);
    t.mock.method(McpProbe.prototype, "readFile", async () => ({
        fileId: config.fileId,
        pageId: "page",
    }));
    const session = new ResidentSession(config);
    try {
        await session.connect();
        pluginConnected(browser.page);
        browser.page.emit("crash");
        await assert.rejects(session.check(), browserUnavailable);
        await session.close();
        browser = new TestBrowser();
        await session.connect();
        pluginConnected(browser.page);
        assert.equal((await session.check()).state, "verified");
    } finally {
        await session.close();
    }
});
