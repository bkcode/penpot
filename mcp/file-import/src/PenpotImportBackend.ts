import { openAsBlob } from "node:fs";
import transit from "transit-js";

export interface ImportedFile {
    id: string;
    name: string;
    projectId: string;
    teamId: string;
}

export interface ImportBackend {
    prepare(projectId?: string): Promise<string>;
    importArchive(path: string, name: string, projectId: string): Promise<ImportedFile[]>;
}

/** Uses a normal login session restricted to the configured resident account and team. */
export class PenpotImportBackend implements ImportBackend {
    private cookie = "";

    private readonly baseUrl: string;
    private readonly credentials: { email: string; password: string };
    private readonly teamId: string;
    constructor(baseUrl: string, credentials: { email: string; password: string }, teamId: string) {
        this.baseUrl = baseUrl;
        this.credentials = { email: credentials.email, password: credentials.password };
        this.teamId = teamId;
        const url = new URL(baseUrl);
        if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
        ) {
            throw new Error("invalid_backend_url");
        }
    }

    async prepare(projectId?: string): Promise<string> {
        const login = await this.request("login-with-password", this.credentials, false);
        this.cookie = login.headers
            .getSetCookie()
            .map((value) => value.split(";", 1)[0])
            .join("; ");
        await login.body?.cancel();
        if (!this.cookie) throw new Error("backend_login_failed");
        if (projectId) {
            const project = await this.json("get-project", { id: projectId });
            if (project.teamId !== this.teamId) throw new Error("project_outside_configured_team");
            return projectId;
        }
        const projects = await this.json("get-projects", { teamId: this.teamId });
        const drafts = projects.find((project: { isDefault: boolean }) => project.isDefault);
        if (!drafts?.id) throw new Error("project_drafts_not_found");
        return drafts.id;
    }

    async importArchive(path: string, name: string, projectId: string): Promise<ImportedFile[]> {
        const data = new FormData();
        data.set("project-id", projectId);
        data.set("name", name);
        data.set("file", await openAsBlob(path, { type: "application/octet-stream" }), name + ".penpot");
        const response = await this.request("import-binfile", data);
        const result = await PenpotImportBackend.readImportResult(response);
        const ids = Array.isArray(result) ? result : (result["file-ids"] ?? result.fileIds);
        if (!Array.isArray(ids) || !ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
            throw new Error("import_result_unconfirmed_check_project_before_retry");
        }
        // Import is already committed: metadata lookup failure must not turn success into a retry.
        let summaries: { id: string; name: string }[] = [];
        try {
            summaries = await this.json("get-project-files", { projectId });
        } catch {}
        return ids.map((id) => ({
            id,
            name: summaries.find((file) => file.id === id)?.name ?? name,
            projectId,
            teamId: this.teamId,
        }));
    }

    static async readImportResult(response: Response): Promise<Record<string, unknown> | unknown[]> {
        if (!response.body) throw new Error("import_response_empty");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let bytes = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.length;
                if (bytes > 32 * 1024 * 1024) throw new Error("import_response_limit_check_project_before_retry");
                buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
                let end: number;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const event = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const type = event
                        .split("\n")
                        .find((line) => line.startsWith("event:"))
                        ?.slice(6)
                        .trim();
                    if (type === "error") throw new Error("backend_import_rejected_check_project_before_retry");
                    if (type !== "end") continue;
                    const data = event
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    return PenpotImportBackend.toJson(transit.reader("json").read(data)) as
                        Record<string, unknown> | unknown[];
                }
            }
            throw new Error("import_result_unconfirmed_check_project_before_retry");
        } finally {
            await reader.cancel().catch(() => undefined);
        }
    }

    private static toJson(value: any): unknown {
        if (transit.isKeyword(value) || transit.isUUID(value)) return value.toString();
        if (Array.isArray(value)) return value.map((item) => this.toJson(item));
        if (transit.isMap(value)) {
            const result: Record<string, unknown> = {};
            value.forEach((item: unknown, key: unknown) => {
                result[String(key).replace(/^:/, "")] = this.toJson(item);
            });
            return result;
        }
        if (transit.isSet(value)) {
            const items: unknown[] = [];
            value.forEach((item: unknown) => items.push(this.toJson(item)));
            return items;
        }
        return value;
    }

    private async json(method: string, data: object): Promise<any> {
        const response = await this.request(method, data);
        return response.json();
    }

    private async request(method: string, data: object | FormData, authenticated = true): Promise<Response> {
        const response = await fetch(new URL(`/api/main/methods/${method}`, this.baseUrl), {
            method: "POST",
            headers: {
                Accept: "application/json, text/event-stream",
                ...(data instanceof FormData ? {} : { "Content-Type": "application/json" }),
                ...(authenticated ? { Cookie: this.cookie } : {}),
            },
            body: data instanceof FormData ? data : JSON.stringify(data),
            redirect: "manual",
            signal: AbortSignal.timeout(method === "import-binfile" ? 600_000 : 15_000),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`backend_http_${response.status}`);
        }
        return response;
    }
}
