import { McpProbe } from "./McpProbe.ts";

export interface PluginActivitySnapshot {
    connected: boolean;
    activeTasks: number;
    oldestTaskAgeMs: number;
    lastActivityAt: string | null;
}

/** Tracks MCP frames without retaining scripts, results, URLs or credentials. */
export class PluginActivity {
    private generation = 0;
    private connected = false;
    private lastActivityAt: number | null = null;
    private readonly tasks = new Map<string, number>();

    open(): number {
        this.generation++;
        this.connected = false;
        this.lastActivityAt = null;
        this.tasks.clear();
        return this.generation;
    }

    receive(generation: number, payload: string | Buffer, now: number = Date.now()): void {
        if (generation !== this.generation) {
            return;
        }
        const message = this.parse(payload);
        if (!message) {
            return;
        }
        if (message.type === "initialized") {
            this.connected = true;
            this.lastActivityAt = now;
        }
        if (typeof message.id === "string" && typeof message.task === "string") {
            this.connected = true;
            this.lastActivityAt = now;
            if (message.task === "executeCode" && message.params?.code === McpProbe.CONTEXT_CODE) {
                return;
            }
            if (!this.tasks.has(message.id)) {
                this.tasks.set(message.id, now);
            }
        }
    }

    sent(generation: number, payload: string | Buffer, now: number = Date.now()): void {
        if (generation !== this.generation) {
            return;
        }
        const message = this.parse(payload);
        if (!message) {
            return;
        }
        if (message.type === "heartbeat" || (typeof message.id === "string" && typeof message.success === "boolean")) {
            this.connected = true;
            this.lastActivityAt = now;
        }
        if (typeof message.id === "string" && typeof message.success === "boolean") {
            this.tasks.delete(message.id);
        }
    }

    close(generation: number): void {
        if (generation === this.generation) {
            this.connected = false;
            this.tasks.clear();
        }
    }

    snapshot(now: number = Date.now()): PluginActivitySnapshot {
        const oldest = this.tasks.size ? Math.min(...this.tasks.values()) : now;
        return {
            connected: this.connected,
            activeTasks: this.tasks.size,
            oldestTaskAgeMs: Math.max(0, now - oldest),
            lastActivityAt: this.lastActivityAt === null ? null : new Date(this.lastActivityAt).toISOString(),
        };
    }

    private parse(payload: string | Buffer): Record<string, any> | null {
        try {
            const value = JSON.parse(payload.toString());
            return value && typeof value === "object" && !Array.isArray(value) ? value : null;
        } catch {
            return null;
        }
    }
}
