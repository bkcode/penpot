import { readFileSync } from "node:fs";

export interface WorkerCredentials {
    email: string;
    password: string;
    mcpKey: string;
}

/** Validated single-file worker configuration. Secrets are loaded only from a file. */
export class WorkerConfig {
    readonly baseUrl: string;
    readonly fileId: string;
    readonly pageId: string;
    readonly teamId: string;
    readonly credentials: WorkerCredentials;
    readonly healthPort: number;
    readonly checkIntervalMs: number;
    readonly retryIntervalMs: number;
    readonly startupTimeoutMs: number;
    readonly failureThreshold: number;
    readonly recoveryGraceMs: number;
    readonly taskBudgetMs: number;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        const base = new URL(this.required(env, "PENPOT_WORKER_BASE_URL"));
        if (
            !["http:", "https:"].includes(base.protocol) ||
            base.username ||
            base.password ||
            base.search ||
            base.hash
        ) {
            throw new Error("PENPOT_WORKER_BASE_URL must be an HTTP(S) URL without credentials, query or fragment");
        }
        if (base.pathname !== "/") {
            throw new Error("PENPOT_WORKER_BASE_URL must point to the site root");
        }
        this.baseUrl = base.origin;
        this.fileId = this.uuid(env, "PENPOT_WORKER_FILE_ID");
        this.pageId = this.uuid(env, "PENPOT_WORKER_PAGE_ID");
        this.teamId = this.uuid(env, "PENPOT_WORKER_TEAM_ID");
        try {
            const data = JSON.parse(readFileSync(this.required(env, "PENPOT_WORKER_CREDENTIALS_FILE"), "utf8"));
            if (![data.email, data.password, data.mcpKey].every((v) => typeof v === "string" && v.length > 0)) {
                throw new Error();
            }
            this.credentials = { email: data.email, password: data.password, mcpKey: data.mcpKey };
        } catch {
            throw new Error("PENPOT_WORKER_CREDENTIALS_FILE must contain email, password and mcpKey");
        }
        this.healthPort = this.integer(env, "PENPOT_WORKER_HEALTH_PORT", 4404, 1, 65535);
        this.checkIntervalMs = this.integer(env, "PENPOT_WORKER_CHECK_INTERVAL_MS", 15000, 1000, 300000);
        this.retryIntervalMs = this.integer(env, "PENPOT_WORKER_RETRY_INTERVAL_MS", 5000, 1000, 300000);
        this.startupTimeoutMs = this.integer(env, "PENPOT_WORKER_STARTUP_TIMEOUT_MS", 90000, 1000, 300000);
        this.failureThreshold = this.integer(env, "PENPOT_WORKER_FAILURE_THRESHOLD", 3, 2, 20);
        this.recoveryGraceMs = this.integer(env, "PENPOT_WORKER_RECOVERY_GRACE_MS", 150000, 120000, 600000);
        this.taskBudgetMs = this.integer(env, "PENPOT_WORKER_TASK_BUDGET_MS", 150000, 120000, 600000);
    }

    get workspaceUrl(): string {
        const query = new URLSearchParams({ "team-id": this.teamId, "file-id": this.fileId, "page-id": this.pageId });
        return `${this.baseUrl}/#/workspace?${query}`;
    }

    get mcpUrl(): string {
        const url = new URL("/mcp/stream", this.baseUrl);
        url.searchParams.set("userToken", this.credentials.mcpKey);
        return url.href;
    }

    private required(env: NodeJS.ProcessEnv, name: string): string {
        const value = env[name]?.trim();
        if (!value) {
            throw new Error(`Missing ${name}`);
        }
        return value;
    }

    private uuid(env: NodeJS.ProcessEnv, name: string): string {
        const value = this.required(env, name);
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
            throw new Error(`${name} must be a UUID`);
        }
        return value;
    }

    private integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
        const value = env[name] === undefined ? fallback : Number(env[name]);
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`Invalid ${name}`);
        }
        return value;
    }
}
