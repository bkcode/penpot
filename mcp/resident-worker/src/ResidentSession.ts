import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { WorkerConfig } from "./WorkerConfig.ts";
import { McpProbe } from "./McpProbe.ts";
import { OriginPolicy } from "./OriginPolicy.ts";
import { PluginActivity } from "./PluginActivity.ts";
import { SessionHealthError, type SessionCheck } from "./SessionHealth.ts";

export interface WorkerSession {
    connect(): Promise<void>;
    check(): Promise<SessionCheck>;
    close(): Promise<void>;
}

/** Isolated browser session pinned to one file, starting on the configured page. */
export class ResidentSession implements WorkerSession {
    private readonly config: WorkerConfig;
    private readonly probe: McpProbe;
    private readonly origins: OriginPolicy;
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private pageCrashed = false;
    private readonly activity = new PluginActivity();

    constructor(config: WorkerConfig) {
        this.config = config;
        this.probe = new McpProbe(config.mcpUrl);
        this.origins = new OriginPolicy(config.baseUrl);
    }

    async connect(): Promise<void> {
        // The worker only trusts its configured Penpot origin; it does not disable web security.
        this.browser = await chromium.launch({
            headless: true,
            args: [
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                `--unsafely-treat-insecure-origin-as-secure=${this.config.baseUrl}`,
            ],
        });
        this.context = await this.browser.newContext({
            locale: "en-US",
            viewport: { width: 1440, height: 900 },
        });
        // Use the same origin for the editor and bundled plugin inside the private worker network.
        await this.context.route("**/js/config.js*", async (route) => {
            const response = await route.fetch();
            const config = this.origins.rewriteConfiguration(await response.text());
            await route.fulfill({ response, body: config });
        });
        await this.context.route("**/assets/**", async (route) => {
            const url = this.origins.assetUrl(route.request().url());
            if (!url || route.request().method() !== "GET") {
                await route.continue();
                return;
            }
            const response = await this.context!.request.get(url);
            await route.fulfill({
                response,
                headers: {
                    ...response.headers(),
                    "access-control-allow-origin": this.config.baseUrl,
                    "access-control-allow-credentials": "true",
                },
            });
        });
        const login = await this.context.request.post(`${this.config.baseUrl}/api/main/methods/login-with-password`, {
            data: {
                email: this.config.credentials.email,
                password: this.config.credentials.password,
            },
            timeout: this.config.startupTimeoutMs,
        });
        if (!login.ok()) {
            throw new Error("Worker authentication failed");
        }
        this.page = await this.context.newPage();
        this.pageCrashed = false;
        this.page.on("crash", () => {
            this.pageCrashed = true;
        });
        this.page.on("websocket", (socket) => {
            const url = new URL(socket.url());
            if (url.host !== new URL(this.config.baseUrl).host || url.pathname !== "/mcp/ws") {
                return;
            }
            const generation = this.activity.open();
            socket.on("framereceived", ({ payload }) => this.activity.receive(generation, payload));
            socket.on("framesent", ({ payload }) => this.activity.sent(generation, payload));
            socket.on("close", () => this.activity.close(generation));
        });
        this.page.setDefaultTimeout(this.config.startupTimeoutMs);
        await this.page.goto(this.config.workspaceUrl, {
            waitUntil: "domcontentloaded",
        });
        await this.page.getByRole("button", { name: "MCP", exact: true }).waitFor({ state: "visible" });
        // Enabled accounts auto-connect; explicitly reconnect if initialization needs recovery.
        const deadline = Date.now() + this.config.startupTimeoutMs;
        while (Date.now() < deadline) {
            try {
                await this.verifyTarget();
                return;
            } catch {
                await this.page.getByRole("button", { name: "MCP", exact: true }).click();
                const connect = this.page.getByRole("menuitem", {
                    name: /^(Connect|Reconnect)$/i,
                });
                if (await connect.count()) {
                    await connect.click();
                } else {
                    await this.page.keyboard.press("Escape");
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        throw new Error("Worker could not connect to the target file");
    }

    async check(): Promise<SessionCheck> {
        this.ensureBrowserAvailable();
        const activity = this.activity.snapshot();
        if (!activity.connected) {
            throw new SessionHealthError("plugin_disconnected");
        }
        if (activity.activeTasks > 0 && activity.oldestTaskAgeMs < this.config.taskBudgetMs) {
            return { state: "busy", ...activity };
        }
        await this.verifyTarget();
        return { state: "verified", ...this.activity.snapshot() };
    }

    private async verifyTarget(): Promise<void> {
        try {
            const actual = await this.probe.readFile();
            this.ensureBrowserAvailable();
            if (actual.fileId !== this.config.fileId) {
                throw new SessionHealthError("target_mismatch");
            }
        } catch (error) {
            this.ensureBrowserAvailable();
            throw new SessionHealthError(SessionHealthError.reasonOf(error));
        }
    }

    private ensureBrowserAvailable(): void {
        if (this.pageCrashed || !this.browser?.isConnected() || !this.page || this.page.isClosed()) {
            throw new SessionHealthError("browser_unavailable");
        }
    }

    async close(): Promise<void> {
        await this.probe.close();
        await this.context?.close().catch(() => undefined);
        await this.browser?.close().catch(() => undefined);
        this.context = null;
        this.browser = null;
        this.page = null;
    }
}
