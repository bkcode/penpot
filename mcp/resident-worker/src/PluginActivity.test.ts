import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginActivity } from "./PluginActivity.ts";
import { McpProbe } from "./McpProbe.ts";

test("tracks active business tasks and removes successful and failed responses", () => {
    const activity = new PluginActivity();
    const id = activity.open();
    activity.receive(id, '{"type":"initialized"}', 1000);
    activity.receive(id, '{"id":"job","task":"executeCode","params":{"code":"private code"}}', 2000);
    assert.deepEqual(activity.snapshot(22000), {
        connected: true,
        activeTasks: 1,
        oldestTaskAgeMs: 20000,
        lastActivityAt: new Date(2000).toISOString(),
    });
    activity.sent(id, '{"type":"heartbeat"}', 22000);
    activity.sent(id, '{"id":"job","success":false,"error":"private error"}', 23000);
    assert.equal(activity.snapshot(23000).activeTasks, 0);
    activity.receive(id, '{"id":"export","task":"exportShape","params":{}}', 24000);
    activity.sent(id, '{"id":"export","success":true,"data":"private output"}', 25000);
    assert.equal(activity.snapshot(25000).activeTasks, 0);
    assert.equal(JSON.stringify(activity.snapshot()).includes("private"), false);
});

test("health probes are not treated as business tasks", () => {
    const activity = new PluginActivity();
    const id = activity.open();
    activity.receive(
        id,
        JSON.stringify({ id: "probe", task: "executeCode", params: { code: McpProbe.CONTEXT_CODE } }),
        1000
    );
    assert.equal(activity.snapshot(5000).activeTasks, 0);
});

test("a stale socket cannot clear the new connection or its pending tasks", () => {
    const activity = new PluginActivity();
    const oldId = activity.open();
    const id = activity.open();
    activity.receive(id, '{"type":"initialized"}', 1000);
    activity.receive(id, '{"id":"job","task":"executeCode"}', 1500);
    activity.close(oldId);
    activity.sent(oldId, '{"id":"job","success":true}', 2000);
    assert.equal(activity.snapshot(2500).connected, true);
    assert.equal(activity.snapshot(2500).activeTasks, 1);
    activity.close(id);
    assert.equal(activity.snapshot(2500).connected, false);
    assert.equal(activity.snapshot(2500).activeTasks, 0);
});

test("ignores malformed and unrelated frames without exposing their contents", () => {
    const activity = new PluginActivity();
    const id = activity.open();
    for (const value of ["not-json", "null", "[]", '"secret"']) {
        activity.receive(id, value);
        activity.sent(id, value);
    }
    assert.equal(activity.snapshot().activeTasks, 0);
    assert.equal(activity.snapshot().connected, false);
});

test("a heartbeat or valid task result confirms a connection even when its initialization event was missed", () => {
    const activity = new PluginActivity();
    const id = activity.open();
    activity.sent(id, '{"type":"heartbeat"}', 2000);
    assert.equal(activity.snapshot().connected, true);
    const next = activity.open();
    activity.sent(next, '{"id":"probe","success":true}', 3000);
    assert.equal(activity.snapshot().connected, true);
});
