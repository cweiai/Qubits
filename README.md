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
