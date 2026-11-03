# 本地部署

本项目只有一个工作目录：`/Users/yangzhaohui/work/www/harness/penpot`，Git 远程为 `git@github.com:bkcode/penpot.git`，使用 `main` 分支。源码、常驻 worker 和本机部署配置均在此仓库维护。

## 运行

唯一的本机部署入口是根目录 `compose.yaml`。应用镜像固定为 Penpot 2.18.5，前端从 `frontend/selfhost` 构建（基于同版本官方镜像），worker 从 `mcp/resident-worker` 构建。Compose 项目名固定为 `penpot`。

```bash
cd /Users/yangzhaohui/work/www/harness/penpot
docker compose up -d --build
docker compose ps
docker compose logs --tail=100
docker compose stop
```

当前页面地址为 <http://192.168.21.230:9001>，本机也可使用 <http://localhost:9001>。测试邮件入口仅绑定本机 <http://localhost:8025>。局域网地址和监听地址由 `.env` 的 `PENPOT_PUBLIC_URI`、`PENPOT_BIND_ADDRESS` 设置。

`docker compose up -d` 可直接恢复已有镜像；修改 worker 源码后才需要 `--build`。Mac 和 OrbStack/Docker 需要保持运行。

## 本地配置

`.env` 保存部署密钥、数据库密码、页面地址和 worker 目标 UUID。`.env.compose.example` 是不含真实密钥的部署示例；原 `.env.example` 用于上游开发工具。现有安装直接使用已配置的 `.env`。

当前必需的凭据文件均已从 Git 排除，权限为 600：

- `.local-credentials.json`：个人账号 `owner@penpot.local` 的登录信息。
- `.worker-credentials.json`：后台账号 `mcp-worker@penpot.local` 的密码及 MCP Key，只读挂载到 worker。

新安装先配置 `.env` 的部署密钥，通过 `docker compose up -d penpot-frontend` 启动应用；随后创建后台账号、完成引导、启用 MCP，并赋予目标团队和文件的编辑权限。将目标 UUID 填入 `.env`，在根目录创建以下 `.worker-credentials.json` 后启动完整部署：

```json
{"email":"worker@example.test","password":"YOUR_PASSWORD","mcpKey":"YOUR_MCP_KEY"}
```

```bash
chmod 600 .env .worker-credentials.json
docker compose up -d --build
```

Codex 使用后台账号的 MCP Key，连接地址格式为 `http://localhost:9001/mcp/stream?userToken=YOUR_MCP_KEY`。客户端连接配置在 Codex 用户配置中维护，无需另存一份项目内连接凭据。

## MCP 常驻

当前后台固定打开文件“Penpot MCP 验证”，文件内可以切换页面。日常 Chrome 可关闭，worker 在独立容器中运行编辑器和 MCP 插件，容器内存上限为 4 GiB（按需使用，并非预分配）。

健康检查：

```bash
docker compose exec penpot-worker node -e "fetch('http://127.0.0.1:4404/readyz').then(async r=>console.log(r.status,await r.text()))"
```

`ready` 表示可调用，`busy` 表示正在执行任务。运行中的任务会暂停竞争性探针；一次探针失败会保留会话，持续失败才恢复浏览器。确认页面崩溃时会跳过宽限期，在下一次检查时恢复；若探针正在等待响应，则在探针结束后识别崩溃。恢复预算及源码说明见 [worker README](mcp/resident-worker/README.md)。MCP 的默认 120 秒调用期限仍有效。

## 图片

后端使用私有 DNS-over-HTTPS 服务，避免代理 Fake-IP 导致 `ssrf-blocked-target`。DNS 无主机端口，SSRF 目标及重定向校验继续生效。配置和验证方式见 [DNS.md](mcp/resident-worker/DNS.md)。默认 DNS 子网是 `172.30.250.0/24`；部署到其他环境前需检查网络冲突。

原登录页 Google `aida` 图片地址由源站返回 403。重建该页面可使用业务项目已有的 `src/assets/design/login-logo.png`，通过本地上传或 `penpot.uploadMediaData(name, bytes, 'image/png')` 导入。插件不能直接读取 Mac 文件路径，MCP 客户端需要提供图片字节。

## 数据

设计文件在 `penpot_penpot_postgres_v15` 数据卷，素材在 `penpot_penpot_assets` 数据卷。目录整理不改变这些卷及现有设计进度。停止服务使用 `docker compose stop`；删除容器后也应复用这些数据卷。`docker compose down -v` 会删除设计数据和素材。

Penpot AI Kit 仍安装在用户目录 `~/.penpot-ai-kit`；它是共享技能安装，不是第二份 Penpot 项目。

## 侧栏显示

`frontend/selfhost/sidebar.css` 隐藏仪表盘侧栏的 Enterprise 推广及当前订阅卡片，前端镜像在构建时加载该样式。它只调整界面显示，不改变授权、订阅状态或管理控制台功能。更新后已打开的页面需要刷新。构建会检查两个卡片的 CSS 类是否存在；升级 Penpot 后如类名变化，应更新样式再构建。

前端 `PENPOT_FLAGS` 使用官方 `disable-dashboard-templates-section` 开关，隐藏仪表盘整个“库和模板”推荐区（含标题和所有推荐卡片）。此开关不影响设计文件内的组件库、素材库及已有内容。
