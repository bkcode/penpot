import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveDownload } from "./ArchiveDownload.ts";
import type { ImportedFile, ImportBackend } from "./PenpotImportBackend.ts";

export interface ImportRequest {
    requestId: string;
    url: string;
    projectId?: string;
    name?: string;
}

export interface ImportJob {
    jobId: string;
    status: "preparing" | "downloading" | "importing" | "completed" | "failed" | "interrupted";
    createdAt: string;
    updatedAt: string;
    sourceHash: string;
    projectId?: string;
    files?: ImportedFile[];
    error?: string;
}

export interface ArchiveSource {
    download(url: string, destination: string): Promise<number>;
}

/** Serializes imports and persists request identities so retries cannot silently duplicate files. */
export class ImportJobs {
    private readonly jobs = new Map<string, ImportJob>();
    private active = false;
    private running: Promise<void> | null = null;

    private readonly directory: string;
    private readonly backend: ImportBackend;
    private readonly source: ArchiveSource;
    constructor(directory: string, backend: ImportBackend, source: ArchiveSource) {
        this.directory = directory;
        this.backend = backend;
        this.source = source;
    }

    async initialize(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        for (const name of await readdir(this.directory)) {
            if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
            const job: ImportJob = JSON.parse(await readFile(join(this.directory, name), "utf8"));
            if (["preparing", "downloading", "importing"].includes(job.status)) {
                job.status = "interrupted";
                job.error = "service_restarted_check_project_before_retry";
                await this.save(job);
            }
            this.jobs.set(job.jobId, job);
        }
    }

    async start(request: ImportRequest): Promise<ImportJob> {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.requestId)) {
            throw new Error("invalid_request_id");
        }
        request = { ...request, requestId: request.requestId.toLowerCase() };
        ArchiveDownload.validateUrl(request.url);
        if (request.projectId && !/^[0-9a-f-]{36}$/i.test(request.projectId)) throw new Error("invalid_project_id");
        if (
            request.name !== undefined &&
            (!request.name.trim() || request.name.length > 250 || /[\x00-\x1f\x7f]/.test(request.name))
        )
            throw new Error("invalid_import_name");
        const sourceHash = createHash("sha256")
            .update(JSON.stringify([request.url, request.projectId ?? "", request.name ?? ""]))
            .digest("hex");
        const previous = this.jobs.get(request.requestId);
        if (previous) {
            if (previous.sourceHash !== sourceHash) throw new Error("request_id_reused_with_different_input");
            return structuredClone(previous);
        }
        if (this.active) throw new Error("import_busy_retry_after_current_job");
        if (this.jobs.size >= 1000) throw new Error("import_job_history_full_contact_operator");
        this.active = true;
        const at = new Date().toISOString();
        const job: ImportJob = {
            jobId: request.requestId,
            status: "preparing",
            createdAt: at,
            updatedAt: at,
            sourceHash,
        };
        try {
            await this.save(job);
            this.jobs.set(job.jobId, job);
        } catch (error) {
            this.active = false;
            throw error;
        }
        this.running = this.run(job, request).finally(() => {
            this.active = false;
        });
        // The job record is the source of truth; never leak an unhandled rejection from persistence failures.
        void this.running.catch(() =>
            console.error("Import job persistence failed; check the project before retrying")
        );
        return structuredClone(job);
    }

    get(jobId: string): ImportJob {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error("import_job_not_found");
        return structuredClone(job);
    }

    async idle(): Promise<void> {
        await this.running;
    }

    private async run(job: ImportJob, request: ImportRequest): Promise<void> {
        let directory: string | undefined;
        try {
            job.projectId = await this.backend.prepare(request.projectId);
            directory = await mkdtemp(join(tmpdir(), "penpot-import-"));
            job.status = "downloading";
            await this.save(job);
            const archive = join(directory, "archive.penpot");
            await this.source.download(request.url, archive);
            job.status = "importing";
            await this.save(job);
            const name =
                request.name ??
                (decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) || "Imported file")
                    .replace(/\.penpot$/i, "")
                    .replace(/[\x00-\x1f\x7f]/g, "")
                    .slice(0, 250) ||
                    "Imported file");
            job.files = await this.backend.importArchive(archive, name, job.projectId);
            job.status = "completed";
            await this.save(job);
        } catch (error) {
            job.status = "failed";
            const message = error instanceof Error ? error.message : "";
            job.error = /^(archive_|ssrf_|backend_|project_|import_)[a-z0-9_]+$/.test(message)
                ? message
                : "import_failed_check_project_before_retry";
            await this.save(job);
        } finally {
            if (directory) await rm(directory, { recursive: true, force: true });
        }
    }

    private async save(job: ImportJob): Promise<void> {
        job.updatedAt = new Date().toISOString();
        const path = join(this.directory, job.jobId + ".json");
        await writeFile(path + ".tmp", JSON.stringify(job), { mode: 0o600 });
        await rename(path + ".tmp", path);
    }
}
