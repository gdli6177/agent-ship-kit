---
name: ship-setup
description: >-
  Slash command /ship-setup. The skill name is ship-setup, matching that
  command, so Cursor, Claude Code, and similar hosts load this file when the
  human types /ship-setup. Initialize one clone via the agent-ship CLI
  (setup, init, uninstall, purge). Also use it when AGENTS.md, local hooks,
  or .git/info/exclude are missing the captain rules.
---

# ship-setup

`/ship-setup` is the captain command. It runs `agent-ship setup` (alias `agent-ship init`) inside the project the human has open. It is idempotent: a second run updates the rules block and the hooks in place and does not duplicate them.

## Local by default

Everything this installs stays in the owner's clone. Other developers of the same project who do not use agent-ship-kit must not see it.

- Hooks are written only under `.git/hooks` (`pre-commit`, `pre-push`). They are not committed. Setup never sets `core.hooksPath`.
- If a hook already exists, it is moved to `pre-commit.agent-ship-chain` or `pre-push.agent-ship-chain` and run after the kit hook. The original file is not overwritten in place.
- `.agent-ship/`, `.env*`, and `*.storage-state.json` are added to `.git/info/exclude`, not to the shared `.gitignore`.
- The rules block is merged into `AGENTS.md` between `<!-- agent-ship:rules:start -->` and `<!-- agent-ship:rules:end -->` only when `AGENTS.md` is not already tracked. That file is then excluded too. A tracked `AGENTS.md` is left untouched; the same block is written to `.agent-ship/AGENTS.local.md`.
- `agent-ship setup --shared` is the explicit opt-in that writes a marked block in the shared `.gitignore` and merges the rules into `AGENTS.md` even when that file is tracked. Hooks stay local even then.
- `agent-ship setup --uninstall` removes the kit hooks (restoring a chained hook) and the rules block. Kept `.agent-ship/` data stays, and a minimal `.agent-ship/` line remains in `.git/info/exclude` so `git status` stays clean. `--purge` deletes `.agent-ship/` and removes that line too.

Do not tell the human to commit `.git/hooks`, `.git/info/exclude`, or a local `AGENTS.md`.

## What the command does

Run this in the project directory. Use `agent-ship` on `PATH` (the installer links it from `~/.local/bin`). If that command is not found, use `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js` with the same arguments. `current` is a symlink to the installed ref.

```bash
agent-ship setup
```

It creates `.agent-ship/` (proposals, contracts, packets, e2e index, notify policy, allowlist), records `kit-root` and `node-bin` for the hooks, installs the hooks, then prints a JSON report of what changed and a self-check. Re-running prints `unchanged` where the files already match.

## Always-on rules in the block

- Talk to the human only as the captain. Do not open worker sessions.
- Do not spawn a worker before the human freezes the contract.
- Stay inside Allowed paths. Never touch Forbidden paths.
- At most 3 workers across all contracts.
- An independent verifier must agree before `needs_review` is filed.
- Only the human merges or ships.
- Never handle passwords, cookies, or storageState contents.
- Use `/ship-setup`, `/ship-contract`, `/ship-dispatch`, `/ship-inbox`, `/ship-notify`, `/ship-e2e`, and `/ship-watchdog`. Each name matches a skill. `/ship-inbox <id>` is the review deep link.

## Hooks

`pre-commit` runs `agent-ship check --staged --contract <id>` when `.agent-ship/active-contract` names a contract. No active contract means the path check is skipped and any chained hook still runs. `pre-push` refuses `main`, `master`, and names listed in `.agent-ship/protected-branches`. A human may set `AGENT_SHIP_ALLOW_PROTECTED_PUSH=1`. The captain must not set that variable.

The hooks are plain shell. They call the CLI with `shell` off inside the CLI. They do not talk to GitHub, GitLab, or any other forge.

## 团队手册与经验入口

普通 setup 只建立本地 team 引用。明确采用共享初始化时用 `setup --shared`：
引用已有手册，或创建精简的 `docs/agent-team/handbook.md` 与可版本管理的
`agent-ship.team.json`。既有配置和手册不覆盖；不同来源的参数发生冲突时报告给维护者。
已有手册可通过 `--handbook` 指定，经验索引目录可用 `--lessons` 指定。

手册、索引和活动经验由使用方拥有；运行回执留在 `.agent-ship/`。
不预填经验，不把整段历史放进 AGENTS.md，不将团队约定写死在安装器中。
工具升级/卸载不改写或删除共享手册、配置和经验。
完整配置和职责见安装包的 `docs/team-and-learning.md`。
