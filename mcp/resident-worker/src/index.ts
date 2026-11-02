import { createServer } from "node:http";
import { WorkerConfig } from "./WorkerConfig.ts";
import { ResidentSession } from "./ResidentSession.ts";
import { ResidentWorker } from "./ResidentWorker.ts";

async function main(): Promise<void> {
    const config = new WorkerConfig();
    const worker = new ResidentWorker(new ResidentSession(config), config.checkIntervalMs, config.retryIntervalMs, {
        failureThreshold: config.failureThreshold,
        recoveryGraceMs: config.recoveryGraceMs,
    });
    const server = createServer((request, response) => {
        if (request.method !== "GET" || !["/healthz", "/readyz"].includes(request.url ?? "")) {
            response.writeHead(404).end();
            return;
        }
        const status = worker.getStatus();
        response.writeHead(request.url === "/healthz" || ["ready", "busy"].includes(status.state) ? 200 : 503, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ ...status, fileId: config.fileId, pageId: config.pageId }));
    });
    server.listen(config.healthPort, "0.0.0.0");
    let stopping = false;
    const stop = async () => {
        if (stopping) {
            return;
        }
        stopping = true;
        server.close();
        const deadline = setTimeout(() => process.exit(1), 15000);
        deadline.unref();
        await worker.stop();
        clearTimeout(deadline);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await worker.start();
}

main().catch(() => {
    console.error("Resident worker failed to start; check configuration and mounted credentials");
    process.exitCode = 1;
});
