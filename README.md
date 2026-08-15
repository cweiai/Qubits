# Qubits

Multi-agent conversational web-app generator (Next.js + React/TypeScript). Mike's team
(迈克/艾玛/艾瑞斯/鲍勃/亚历克斯/大卫/评审员) writes real React/TS code in an isolated
workspace, builds it, reviews it and publishes a live preview — all through real tool
calls.

## Sandbox (security model)

All agent command execution is **physically isolated in Docker** — there is no local
execution mode and no fallback:

- `SANDBOX_PROVIDER` only accepts `container` (the default); any other value makes the
  server refuse to start.
- `ContainerSandboxProvider` (`lib/ai/tools/sandbox-provider.ts`) runs every command as:
  `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges
  --user 10001:10001 --read-only --memory 512m --cpus 1 --pids-limit 128`, mounting
  **only** the canonicalized (symlink-free) workspace at `/workspace`.
- Docker or image unavailable → `PROVIDER_UNAVAILABLE`, fail closed. Never host execution.

Agent file access goes through the unified jail in `lib/workspace/paths.ts`:

- rejects absolute paths, Windows/mixed separators, NUL, empty/overlong paths and every
  `..` segment;
- walks every path segment with `lstatSync` — intermediate or final symlinks and special
  files (socket/FIFO/device) are rejected (`PATH_ESCAPE`);
- reads/writes open with `O_NOFOLLOW`;
- a per-workspace async mutex serializes agent fs tools, container exec, build, format,
  snapshot and checkpoint (TOCTOU guard);
- after every `bash` call the tree is re-scanned; a planted symlink/special file marks
  the task `SECURITY_BLOCKED` and blocks all reads, builds, previews and snapshots.

### Toolchain image

The workspace check runner (typecheck/lint/tests) executes inside the container using
the `qubits-toolchain:latest` image (node + pinned typescript/eslint/vitest with
linux-native binaries). Build it once per machine:

```bash
bash scripts/build-toolchain-image.sh   # NPM_REGISTRY=https://registry.npmmirror.com on CN networks
```

The host's `node_modules` (types only) and the system-maintained ESLint/Vitest configs
are mounted read-only into the container.

## 一键上线（One-click deploy）

每个对话的当前构建产物都可以一键部署到公网临时链接（预览工具栏「一键上线」按钮）：

- **容器化**：每次部署生成一个独立 Docker 容器（`qubits-deploy-web:latest`，
  基于 node:24-alpine + 内置零依赖静态服务器，首次部署时自动构建；离线环境可先
  `docker pull docker.m.daocloud.io/library/node:24-alpine` 并 tag 为 `node:24-alpine`）。
  容器与工作区沙盒同等级加固：
  `cap-drop ALL`、`no-new-privileges`、只读根、非 root、内存/CPU/pid 限额，端口只发布在
  `127.0.0.1`。
- **公网隧道**：部署路由器（`127.0.0.1:3100`，路径 `/d/<deploymentId>/` + 子域路由）
  通过 Cloudflare Quick Tunnel 暴露到公网 —— 免费、无需账号，自动分配随机
  `*.trycloudflare.com` 域名。`cloudflared` 缺失时自动下载到 `bin/cloudflared`
  （或 `brew install cloudflared` 手动安装；`DEPLOY_TUNNEL_BINARY` 可指定路径）。
- **数据仍然入库**：部署包在构建产物里注入嵌入式宿主桥（与预览完全相同的
  MessageChannel 握手协议），数据请求经 `/api/deploy/data` 公开接口走回 Qubits 后端，
  服务端重新校验集合/操作/查询/载荷；打开同一链接的访问者共享同一份数据。
- **生命周期**：链接为临时地址（默认 12 小时，`DEPLOY_TTL_HOURS` 可调），到期自动下线；
  可手动「下线」；同一对话同一时间只有一个在线部署；Qubits 服务重启后所有旧链接失效
  （随机域名随隧道重建），需重新上线。历史与状态持久化在 `deployments` 表。
- **禁用**：`DEPLOY_ENABLED=0` 关闭整个功能；`DEPLOY_PUBLIC_TUNNEL=0` 只提供本地链接。

## Development

```bash
npm install
bash scripts/build-toolchain-image.sh
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
npm test           # unit tests (Docker-dependent ones skip automatically without a daemon)
npm run test:e2e   # requires a running Docker daemon
```

Database: SQLite via `node:sqlite` (`data/qubits.db`), workspaces under
`data/workspaces/<taskId>`, immutable snapshots under `data/snapshots/`.
