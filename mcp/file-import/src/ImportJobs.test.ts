import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImportJobs } from "./ImportJobs.ts";
import type { ImportBackend } from "./PenpotImportBackend.ts";

const id = "00000000-0000-4000-8000-000000000001";
const nextId = "00000000-0000-4000-8000-000000000002";
const request = { requestId: id, url: "https://example.com/a.penpot?signature=private" };
class TestBackend implements ImportBackend {
    imports = 0;
    async prepare(): Promise<string> {
        return "project";
    }
    async importArchive() {
        this.imports++;
        return [{ id, projectId: "project", teamId: "team", name: "Library" }];
    }
}

test("successful import is persisted, temp archive removed, and same request never imports twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "import-jobs-test-"));
    const backend = new TestBackend();
    let archive = "";
    const source = {
        download: async (_url: string, path: string) => {
            archive = path;
            await writeFile(path, "archive");
            return 7;
        },
    };
    try {
        const jobs = new ImportJobs(directory, backend, source);
        await jobs.initialize();
        assert.equal((await jobs.start(request)).jobId, id);
        await jobs.idle();
        assert.equal(jobs.get(id).status, "completed");
        assert.equal(backend.imports, 1);
        await assert.rejects(readFile(archive));
        const reloaded = new ImportJobs(directory, backend, source);
        await reloaded.initialize();
        assert.equal((await reloaded.start(request)).status, "completed");
        assert.equal(backend.imports, 1);
        assert.ok(!(await readFile(join(directory, id + ".json"), "utf8")).includes("signature"));
        await assert.rejects(reloaded.start({ ...request, url: "https://example.com/other.penpot" }), /reused/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("serializes imports, redacts private failures and removes failed downloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "import-jobs-test-"));
    let finish!: () => void;
    let archive = "";
    const source = {
        download: async (_url: string, path: string) => {
            archive = path;
            await new Promise<void>((resolve) => {
                finish = resolve;
            });
            throw new Error("https://private/?token=secret");
        },
    };
    const jobs = new ImportJobs(directory, new TestBackend(), source);
    try {
        await jobs.initialize();
        await jobs.start(request);
        await assert.rejects(jobs.start({ ...request, requestId: nextId }), /busy/);
        // Wait for the async preparation/save to reach the controllable download boundary.
        while (!finish) await new Promise<void>((resolve) => setImmediate(resolve));
        finish();
        await jobs.idle();
        assert.equal(jobs.get(id).status, "failed");
        assert.equal(jobs.get(id).error, "import_failed_check_project_before_retry");
        await assert.rejects(readFile(archive));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("restart marks an in-flight import interrupted and never starts it again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "import-jobs-test-"));
    try {
        const backend = new TestBackend();
        const source = { download: async () => 0 };
        const initial = new ImportJobs(directory, backend, source);
        await initial.initialize();
        await initial.start(request);
        await initial.idle();
        const file = join(directory, id + ".json");
        const record = JSON.parse(await readFile(file, "utf8"));
        record.status = "importing";
        await writeFile(file, JSON.stringify(record));
        const restarted = new ImportJobs(directory, backend, source);
        await restarted.initialize();
        assert.equal((await restarted.start(request)).status, "interrupted");
        assert.equal(backend.imports, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
