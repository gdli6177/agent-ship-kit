# Crewvane｜协航

**交代目标，团队交付。**

A local desktop workspace for agent teams. Give the captain a goal; a temporary
lead coordinates configurable stages and workers. Questions go to the immediate
parent first. Only decisions the captain cannot resolve reach you.

- Discover installed OMP, Codex, DeepSeek Harness, Cursor and Qoder.
- Execute through OMP ACP, Codex App Server and DSH ACP; select runtime and model per role, stage or task. Cursor/Qoder are discovery-only in this release.
- Install Herdr from Settings as the recommended optional terminal backend. When present it is selected by default; without it, Shell and discovered runtime CLIs remain available.
- Edit versioned workflow stages, run parallel workers in isolated Git worktrees, require independent verification and bounded rework.
- Grant project scope once; ordinary work proceeds through a PR within that grant. Merge and deployment remain manual.
- Talk to one captain across parallel goals: create, route follow-ups, inspect real status, and resolve persistent routing clarifications.
- Connect team handbooks, review evidence-backed lessons, and let later workers recall approved knowledge.
- Keep test credentials in the OS-backed Electron safe store and inject them only into authorized verification commands.
- Share one append-only workspace record between the desktop app and the `crewvane` CLI.

This is the first macOS arm64 internal desktop release.

[Download desktop installers (GitHub Releases)](https://github.com/gdli6177/crewvane/releases) — after a version is published, choose the `.dmg` or `.zip` asset for Apple Silicon. [Installation and release guide](docs/releases.md). [中文使用说明](docs/crewvane.md) · [产品方案](docs/product/crewvane-v0.1.md) · [Architecture](docs/ARCHITECTURE.md)

```sh
pnpm install
pnpm desktop:dev
# Build a local .app:
pnpm desktop:package
```

CLI installation:

```sh
curl -fsSL https://raw.githubusercontent.com/gdli6177/crewvane/main/install.sh | bash
crewvane --help
```

Upgrading from agent-ship-kit: finish or stop old work, run `crewvane migrate --project <dir> --dry-run`, then migrate before opening the desktop workspace. Use `crewvane legacy uninstall --project <dir> --dry-run` to inspect old integration cleanup. No old command alias is installed. Original state and migration backups are preserved.

```sh
pnpm typecheck
pnpm test
pnpm desktop:build
pnpm test:desktop
pnpm test:crewvane # real runtime trial; requires configured local runtimes/models
pnpm test:product # real captain, knowledge and credential trial; requires Codex
```

The existing manual contract CLI, portable skills and templates remain available under the new brand. [CLI guide](cli/README.md).

## Reuse instead of rebuilding

Crewvane owns the durable task state, delegation, escalation, decisions, workflow versions, evidence and authorization. Standard open-source components cover the surrounding infrastructure:

| Need | Reused component |
| --- | --- |
| Desktop shell | Electron |
| UI primitives | React, Radix UI Themes and Dialog |
| Icons | Lucide |
| Terminal UI | xterm.js |
| PTY execution | node-pty |
| Agent execution protocol | ACP and Codex App Server |
| Optional terminal sessions | Herdr |
| Desktop and browser end-to-end testing | Playwright |

The orchestrator uses a small tested JSON-RPC subset for ACP and Codex App Server. `@agentclientprotocol/sdk` is intentionally not installed because it would not remove a product responsibility or reduce this protocol surface at the current scope.
