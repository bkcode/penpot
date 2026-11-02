import { setTimeout } from "node:timers/promises";
import type { WorkerSession } from "./ResidentSession.ts";
import { SessionHealthError, type SessionCheck, type SessionFailureReason } from "./SessionHealth.ts";

export interface RecoveryOptions {
    failureThreshold: number;
    recoveryGraceMs: number;
}

export interface WorkerStatus {
    state: "starting" | "ready" | "busy" | "degraded" | "recovering" | "stopping";
    attempts: number;
    lastCheckedAt: string | null;
    consecutiveFailures: number;
    firstFailureAt: string | null;
    lastFailureReason: SessionFailureReason | null;
    activeTasks: number;
    oldestTaskAgeMs: number;
    lastActivityAt: string | null;
}

/** Keeps transient probe failures in the existing session until recovery is justified. */
export class ResidentWorker {
    private readonly session: WorkerSession;
    private readonly checkIntervalMs: number;
    private readonly retryIntervalMs: number;
    private readonly recovery: RecoveryOptions;
    private readonly abort = new AbortController();
    private firstFailureTime: number | null = null;
    private status: WorkerStatus = {
        state: "starting",
        attempts: 0,
        lastCheckedAt: null,
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureReason: null,
        activeTasks: 0,
        oldestTaskAgeMs: 0,
        lastActivityAt: null,
    };
    private stopped = false;
    private running: Promise<void> | null = null;

    constructor(
        session: WorkerSession,
        checkIntervalMs: number,
        retryIntervalMs: number,
        recovery: RecoveryOptions = { failureThreshold: 3, recoveryGraceMs: 150000 }
    ) {
        this.session = session;
        this.checkIntervalMs = checkIntervalMs;
        this.retryIntervalMs = retryIntervalMs;
        this.recovery = recovery;
    }

    getStatus(): WorkerStatus {
        return { ...this.status };
    }

    start(): Promise<void> {
        if (!this.running) {
            this.running = this.run();
        }
        return this.running;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.status.state = "stopping";
        this.abort.abort();
        await this.session.close();
        await this.running;
    }

    private async run(): Promise<void> {
        while (!this.stopped) {
            try {
                this.status.attempts++;
                this.status.state = "starting";
                this.clearFailures();
                await this.session.connect();
                while (!this.stopped) {
                    try {
                        const checked = await this.session.check();
                        if (this.stopped) {
                            break;
                        }
                        this.acceptCheck(checked);
                    } catch (error) {
                        if (this.stopped) {
                            break;
                        }
                        if (this.recordFailure(error)) {
                            break;
                        }
                    }
                    await this.wait(this.checkIntervalMs);
                }
            } catch (error) {
                if (!this.stopped) {
                    this.status.state = "recovering";
                    this.status.lastFailureReason = SessionHealthError.reasonOf(error);
                    this.log("worker_connect_failed");
                }
            } finally {
                await this.session.close().catch(() => undefined);
            }
            if (!this.stopped) {
                await this.wait(this.retryIntervalMs);
            }
        }
    }

    private acceptCheck(checked: SessionCheck): void {
        const wasDegraded = this.status.consecutiveFailures > 0;
        this.clearFailures();
        this.status.state = checked.state === "busy" ? "busy" : "ready";
        this.status.activeTasks = checked.activeTasks;
        this.status.oldestTaskAgeMs = checked.oldestTaskAgeMs;
        this.status.lastActivityAt = checked.lastActivityAt;
        if (checked.state === "verified") {
            this.status.lastCheckedAt = new Date().toISOString();
        }
        if (wasDegraded) {
            this.log("worker_probe_recovered");
        }
    }

    private recordFailure(error: unknown): boolean {
        const now = performance.now();
        this.firstFailureTime ??= now;
        this.status.consecutiveFailures++;
        this.status.firstFailureAt ??= new Date().toISOString();
        this.status.lastFailureReason = SessionHealthError.reasonOf(error);
        const confirmedBrowserLoss = this.status.lastFailureReason === "browser_unavailable";
        const elapsedMs = now - this.firstFailureTime;
        const recover =
            confirmedBrowserLoss ||
            (this.status.consecutiveFailures >= this.recovery.failureThreshold &&
                elapsedMs >= this.recovery.recoveryGraceMs);
        this.status.state = recover ? "recovering" : "degraded";
        this.log(recover ? "worker_recovering" : "worker_probe_degraded", elapsedMs);
        return recover;
    }

    private clearFailures(): void {
        this.firstFailureTime = null;
        this.status.consecutiveFailures = 0;
        this.status.firstFailureAt = null;
        this.status.lastFailureReason = null;
    }

    private log(event: string, elapsedMs = 0): void {
        // Only fixed reason codes and counters are logged; errors may contain credentials and scripts.
        console.error(
            JSON.stringify({
                event,
                at: new Date().toISOString(),
                attempts: this.status.attempts,
                reason: this.status.lastFailureReason,
                consecutiveFailures: this.status.consecutiveFailures,
                failureDurationMs: Math.round(elapsedMs),
            })
        );
    }

    private async wait(ms: number): Promise<void> {
        await setTimeout(ms, undefined, { signal: this.abort.signal }).catch(() => undefined);
    }
}
