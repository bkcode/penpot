import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerConfig } from "./WorkerConfig.ts";

function fixture(): { env: NodeJS.ProcessEnv; dispose(): void } {
    const dir = mkdtempSync(join(tmpdir(), "penpot-worker-test-"));
    const credentials = join(dir, "credentials.json");
    writeFileSync(
        credentials,
        JSON.stringify({ email: "worker@example.test", password: "secret", mcpKey: "mcp-secret" })
    );
    return {
        env: {
            PENPOT_WORKER_BASE_URL: "http://penpot-frontend:8080",
            PENPOT_WORKER_FILE_ID: "11111111-1111-1111-1111-111111111111",
            PENPOT_WORKER_PAGE_ID: "22222222-2222-2222-2222-222222222222",
            PENPOT_WORKER_TEAM_ID: "33333333-3333-3333-3333-333333333333",
            PENPOT_WORKER_CREDENTIALS_FILE: credentials,
        },
        dispose: () => rmSync(dir, { recursive: true }),
    };
}

test("constructs a fixed workspace without putting credentials in its URL", () => {
    const f = fixture();
    try {
        const config = new WorkerConfig(f.env);
        const url = new URL(config.workspaceUrl);
        const query = new URLSearchParams(url.hash.split("?")[1]);
        assert.equal(query.get("file-id"), f.env.PENPOT_WORKER_FILE_ID);
        assert.equal(query.get("page-id"), f.env.PENPOT_WORKER_PAGE_ID);
        assert.equal(config.workspaceUrl.includes("secret"), false);
        assert.equal(new URL(config.mcpUrl).searchParams.get("userToken"), "mcp-secret");
    } finally {
        f.dispose();
    }
});

test("rejects malformed targets and ambiguous public URLs before opening a browser", () => {
    const f = fixture();
    try {
        assert.throws(() => new WorkerConfig({ ...f.env, PENPOT_WORKER_FILE_ID: "other-file" }), /must be a UUID/);
        for (const base of [
            "file:///tmp/site",
            "http://secret:password@penpot/",
            "http://penpot/?key=secret",
            "http://penpot/subpath/",
        ]) {
            assert.throws(() => new WorkerConfig({ ...f.env, PENPOT_WORKER_BASE_URL: base }));
        }
        assert.throws(() => new WorkerConfig({ ...f.env, PENPOT_WORKER_HEALTH_PORT: "NaN" }), /Invalid/);
    } finally {
        f.dispose();
    }
});

test("credential errors do not expose file contents or secret values", () => {
    const f = fixture();
    try {
        writeFileSync(f.env.PENPOT_WORKER_CREDENTIALS_FILE!, '{"password":"do-not-log-this"');
        assert.throws(
            () => new WorkerConfig(f.env),
            (error: Error) => {
                assert.equal(error.message.includes("do-not-log-this"), false);
                return /must contain email/.test(error.message);
            }
        );
    } finally {
        f.dispose();
    }
});

test("recovery budgets cover the 120-second business deadline and reject unsafe short overrides", () => {
    const f = fixture();
    try {
        const config = new WorkerConfig(f.env);
        assert.equal(config.failureThreshold, 3);
        assert.equal(config.recoveryGraceMs, 150000);
        assert.equal(config.taskBudgetMs, 150000);
        assert.throws(() => new WorkerConfig({ ...f.env, PENPOT_WORKER_RECOVERY_GRACE_MS: "15000" }), /Invalid/);
        assert.throws(() => new WorkerConfig({ ...f.env, PENPOT_WORKER_TASK_BUDGET_MS: "15000" }), /Invalid/);
        assert.throws(() => new WorkerConfig({ ...f.env, PENPOT_WORKER_FAILURE_THRESHOLD: "1" }), /Invalid/);
    } finally {
        f.dispose();
    }
});
