import assert from "node:assert/strict";
import { test } from "node:test";
import { ResidentWorker } from "./ResidentWorker.ts";
import type { WorkerSession } from "./ResidentSession.ts";
import { SessionHealthError, type SessionCheck } from "./SessionHealth.ts";

class TestSession implements WorkerSession {
    online = true;
    readable = false;
    closed = true;
    busy = false;
    failureReason: "probe_timeout" | "probe_failed" = "probe_failed";

    async connect(): Promise<void> {
        if (!this.online) {
            throw new Error("private URL containing credentials must never be logged");
        }
        this.closed = false;
    }

    async check(): Promise<SessionCheck> {
        if (this.closed || !this.online) {
            throw new SessionHealthError("browser_unavailable");
        }
        if (!this.readable) {
            throw new SessionHealthError(this.failureReason);
        }
        return {
            state: this.busy ? "busy" : "verified",
            activeTasks: this.busy ? 1 : 0,
            oldestTaskAgeMs: this.busy ? 20000 : 0,
            lastActivityAt: new Date().toISOString(),
        };
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Worker did not reach the expected state");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

test("stays unready until the target can be read and recovers after it becomes available", async () => {
    const session = new TestSession();
    const worker = new ResidentWorker(session, 10, 10);
    const run = worker.start();
    try {
        await until(() => worker.getStatus().state === "degraded");
        assert.equal(worker.getStatus().lastCheckedAt, null);
        session.readable = true;
        await until(() => worker.getStatus().state === "ready");
        assert.ok(worker.getStatus().lastCheckedAt);
    } finally {
        await worker.stop();
        await run;
    }
});

test("recreates a lost session and returns to ready after the service recovers", async () => {
    const session = new TestSession();
    session.readable = true;
    const worker = new ResidentWorker(session, 10, 10);
    const run = worker.start();
    try {
        await until(() => worker.getStatus().state === "ready");
        session.online = false;
        await until(() => worker.getStatus().state === "recovering");
        session.online = true;
        await until(() => worker.getStatus().state === "ready");
        assert.ok(worker.getStatus().attempts >= 2);
    } finally {
        await worker.stop();
        await run;
    }
});

test("shutdown interrupts a long check interval and leaves no running session", async () => {
    const session = new TestSession();
    session.readable = true;
    const worker = new ResidentWorker(session, 60000, 60000);
    const run = worker.start();
    await until(() => worker.getStatus().state === "ready");
    await worker.stop();
    await run;
    assert.equal(worker.getStatus().state, "stopping");
    assert.equal(session.closed, true);
});

test("a single slow probe degrades readiness without closing the active browser", async () => {
    const session = new TestSession();
    session.readable = true;
    const worker = new ResidentWorker(session, 10, 10, { failureThreshold: 3, recoveryGraceMs: 5000 });
    const run = worker.start();
    try {
        await until(() => worker.getStatus().state === "ready");
        session.readable = false;
        await until(() => worker.getStatus().state !== "ready");
        assert.equal(worker.getStatus().state, "degraded");
        assert.equal(session.closed, false);
        session.readable = true;
        await until(() => worker.getStatus().state === "ready");
        assert.equal(worker.getStatus().attempts, 1);
    } finally {
        await worker.stop();
        await run;
    }
});

test("repeated probe failures preserve the browser until both threshold and grace expire", async () => {
    const session = new TestSession();
    session.readable = true;
    const worker = new ResidentWorker(session, 10, 10, { failureThreshold: 3, recoveryGraceMs: 150 });
    const run = worker.start();
    try {
        await until(() => worker.getStatus().state === "ready");
        session.readable = false;
        session.failureReason = "probe_timeout";
        await until(() => worker.getStatus().consecutiveFailures >= 3);
        assert.equal(worker.getStatus().state, "degraded");
        assert.equal(worker.getStatus().attempts, 1);
        assert.equal(session.closed, false);
        assert.equal(worker.getStatus().lastFailureReason, "probe_timeout");
        await until(() => worker.getStatus().attempts >= 2);
        session.readable = true;
        await until(() => worker.getStatus().state === "ready");
        assert.equal(worker.getStatus().consecutiveFailures, 0);
        assert.equal(worker.getStatus().firstFailureAt, null);
    } finally {
        await worker.stop();
        await run;
    }
});

test("a busy session stays usable and a transient failure does not reset its task", async () => {
    const session = new TestSession();
    session.readable = true;
    const worker = new ResidentWorker(session, 10, 10, { failureThreshold: 3, recoveryGraceMs: 50 });
    const run = worker.start();
    try {
        await until(() => worker.getStatus().state === "ready");
        session.readable = false;
        await until(() => worker.getStatus().state === "degraded");
        session.readable = true;
        session.busy = true;
        await until(() => worker.getStatus().state === "busy");
        assert.equal(worker.getStatus().activeTasks, 1);
        assert.equal(worker.getStatus().consecutiveFailures, 0);
        assert.equal(worker.getStatus().attempts, 1);
        assert.equal(session.closed, false);
        session.busy = false;
        await until(() => worker.getStatus().state === "ready");
    } finally {
        await worker.stop();
        await run;
    }
});
