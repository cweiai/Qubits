# Qubits

A conversational web-app generator: describe an app in one sentence and a multi-agent
team (Mike, Emma, Iris, Bob, Alex, David, Reviewer) turns it into a real, working
React/TypeScript application — writing actual code in an isolated workspace, building
it, testing and reviewing it, and shipping a live preview, all through real tool calls.
One click deploys the current build to a shareable public URL inside its own container.

## Quick start

Prerequisites: Node.js ≥ 22 (uses `node:sqlite`), a running Docker daemon, and an
OpenAI-compatible API key. `cloudflared` is downloaded automatically on first deploy
(no account needed).

```bash
cp .env.example .env    # set OPENAI_API_KEY (and OPENAI_BASE_URL if not api.openai.com)
npm install
bash scripts/build-toolchain-image.sh   # one-time; use NPM_REGISTRY=https://registry.npmmirror.com on CN networks
npm run dev             # http://localhost:3000
```

Open the workspace, describe your app in the left panel (e.g. “a task manager with
due dates”), and the agent team generates, builds and previews it on the right.

## One-click deploy

With a built app in the preview panel, hit the **一键上线 (Deploy)** button in the
preview toolbar to publish the current build:

- **Containerized**: each deployment runs in its own hardened Docker container
  (`qubits-deploy-web:latest`, node:24-alpine + a tiny dependency-free static server,
  built automatically on first use). Hardening matches the workspace sandbox:
  `cap-drop ALL`, `no-new-privileges`, read-only root, non-root user, memory/cpu/pid
  limits, ports published on `127.0.0.1` only.
- **Public tunnel**: a deploy router (`127.0.0.1:3100`, path `/d/<deploymentId>/` plus
  subdomain routing) is exposed through a Cloudflare Quick Tunnel — free, no account,
  random `*.trycloudflare.com` hostname. Missing `cloudflared` binaries are
  auto-downloaded into `bin/cloudflared` (or set `DEPLOY_TUNNEL_BINARY`).
- **Data still persists**: the served bundle embeds a host bridge speaking the exact
  MessageChannel handshake protocol of the sandboxed preview; data requests flow back
  through `POST /api/deploy/data` to the Qubits backend with server-side re-validation
  of collections, operations, queries and payloads. Everyone opening one link shares
  one dataset.
- **Lifecycle**: links are temporary (default 12 h, `DEPLOY_TTL_HOURS`), expire and
  stop automatically, and can be taken down manually. One live deployment per
  conversation. Restarting the Qubits server invalidates old links (the random
  hostname is re-issued with the tunnel) — deploy again to get a fresh one. History
  lives in the `deployments` table.
- **Opt-outs**: `DEPLOY_ENABLED=0` disables the feature; `DEPLOY_PUBLIC_TUNNEL=0`
  serves local links only. Offline image builds: pre-pull and tag
  `docker.m.daocloud.io/library/node:24-alpine` as `node:24-alpine`.

## How it works

- The agent team writes real React/TypeScript code in a per-task workspace
  (`data/workspaces/<taskId>`); the server-owned esbuild/postcss pipeline bundles it
  into a single self-contained HTML document — no npm install, no lifecycle scripts,
  no network during builds.
- The preview runs inside a `sandbox="allow-scripts"` iframe with a strict CSP; all
  app data flows through the Qubits SDK over a MessageChannel to the sandbox data API,
  re-validated server-side on every request.
- Versioning is fail-safe: only fully built, tested, reviewed and rendered runs are
  promoted to an immutable snapshot; failed attempts never overwrite the last working
  version.

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

Agent file access goes through the unified jail in `lib/workspace/paths.ts`: absolute
paths, `..` segments, symlinks and special files are rejected, reads/writes open with
`O_NOFOLLOW`, a per-workspace mutex serializes all fs/container access, and a planted
symlink blocks the task (`SECURITY_BLOCKED`) before anything runs.

## Development

```bash
npm run lint
npm run typecheck
npm test           # unit tests (Docker-dependent ones skip without a daemon)
npm run test:e2e   # requires a running Docker daemon
```

Database: SQLite via `node:sqlite` (`data/qubits.db`); workspaces under
`data/workspaces/<taskId>`; immutable snapshots under `data/snapshots/`. Configuration
lives in `.env` — see `.env.example` for sandbox, model and deploy options.
