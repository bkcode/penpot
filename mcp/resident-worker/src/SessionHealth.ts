export type SessionFailureReason =
    "browser_unavailable" | "plugin_disconnected" | "probe_timeout" | "probe_failed" | "target_mismatch";

export interface SessionCheck {
    state: "verified" | "busy";
    activeTasks: number;
    oldestTaskAgeMs: number;
    lastActivityAt: string | null;
}

/** Secret-free health failure. Only confirmed browser loss permits immediate recovery. */
export class SessionHealthError extends Error {
    readonly reason: SessionFailureReason;

    constructor(reason: SessionFailureReason) {
        super(reason);
        this.reason = reason;
    }

    static reasonOf(error: unknown): SessionFailureReason {
        if (error instanceof SessionHealthError) {
            return error.reason;
        }
        if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
            return "probe_timeout";
        }
        return "probe_failed";
    }
}
