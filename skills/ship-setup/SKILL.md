---
name: ship-setup
description: >-
  Set up crewvane in the current project when the user says 帮我接入、
  初始化团队、你来当船长, or asks to adopt the kit. Also handles /ship-setup
  and repairs missing captain rules or hooks. Keep ordinary setup local;
  create shared handbook/config only when shared adoption is authorized.
---

# ship-setup

v0.2：检查 setup JSON 的 rules_auto_loaded 和 warnings。tracked AGENTS.md 的
本地模式明确返回“不会自动加载”；必须在当前会话显式读取
`.crewvane/AGENTS.local.md`，并说明下一会话需要宿主桥接或获授权后的 shared setup。
不能仅凭 ok:true 宣称宿主已接通。安装器认识 Claude/Cursor/Codex/Qoder/Kiro/OMP
及共享 .agents；OMP 路径为 ~/.omp/agent/skills。其他目录使用 --target。
新 setup 的提交 guard 会拒绝无冻结合同的提交，初始化文件也需要明确范围授权。
开始会话运行 doctor、team context --auto --project ID，并实际读取必读正文。

`/ship-setup` is the captain command. It runs `crewvane setup` (alias `crewvane init`) inside the project the human has open. It is idempotent: a second run updates the rules block and the hooks in place and does not duplicate them.

## Parallel lanes and authority (v0.2)

Read `$HOME/.crewvane/current/docs/owner-lanes.md` (or the actual kit clone). One human-facing captain routes a durable `intake add/list/claim` queue; temporary owners hold independent lanes and coordinate scouts/workers/verifiers. Keep one current proposal **per lane**. The captain delegates repository inspection/tests/Git work and returns a concise conclusion/tradeoff/evidence/recommendation/id list. External channels enqueue only.

The trusted host binds actors, initializes human/captain authority, connects `scripts/host-pre-tool.mjs`, and starts each captain turn with heartbeat outside model-controlled tools. Never choose another actor or reset your own budget. Registered human channel alone freezes/decides/changes limits; captain alone executes notification. Owners/workers only return lane artifacts/inbox. These application guards require host authentication and sandbox enforcement; local env names alone are not authenticated identities.

Use Lane/Owner headers, independent checkouts, optional slice role cards, and `--lane` for routed actions. `slice open` prepares worktree/hooks/admission/pending packet/check; its `spawn_required` means the adapter must still launch a real instance. A missing/malformed role blocks dispatch. Role forbiddens add to contract forbiddens, never widen scope. A frozen file is immutable; append state to events, not its dispatch-log table.


## Conversational onboarding

The current main conversation becomes the captain when the user asks to adopt
the kit. Do not ask them to find another captain, memorize commands or choose
an orchestrator without first inspecting available capabilities.

- Read project rules and inspect existing setup before changing anything.
  Choose the current host's skills and use its available execution mechanism;
  ask only if a consequential choice cannot be resolved from the environment.
- A request to install tools alone does not authorize project setup. Plain
  adoption uses local setup; a request to create/reuse shared team rules and a
  handbook authorizes `setup --shared`. Preserve existing content and hooks.
- Verify CLI/setup and whether the host can actually create, inspect and
  collect isolated workers and a separate verifier. The CLI is not a runtime.
  If unavailable, report the blocker and one concrete next action; do not
  make the user walk through contract creation before revealing this blocker.
- Finish with a short readiness report (including changed shared files when
  applicable) and “直接告诉我你想做什么 / Tell me what you want to build.”
  New requests use `ship-contract`; the user need not invoke another skill.
- On a new conversation, restore contracts, inbox and actual worker status
  before suggesting work. Never infer live workers from records or re-dispatch.

## Local by default

Everything this installs stays in the owner's clone. Other developers of the same project who do not use crewvane must not see it.

- Hooks are written only under `.git/hooks` (`pre-commit`, `pre-push`). They are not committed. Setup never sets `core.hooksPath`.
- If a hook already exists, it is moved to `pre-commit.crewvane-chain` or `pre-push.crewvane-chain` and run after the kit hook. The original file is not overwritten in place.
- `.crewvane/`, `.env*`, and `*.storage-state.json` are added to `.git/info/exclude`, not to the shared `.gitignore`.
- The rules block is merged into `AGENTS.md` between `<!-- crewvane:rules:start -->` and `<!-- crewvane:rules:end -->` only when `AGENTS.md` is not already tracked. That file is then excluded too. A tracked `AGENTS.md` is left untouched; the same block is written to `.crewvane/AGENTS.local.md`.
- `crewvane setup --shared` is the explicit opt-in that writes a marked block in the shared `.gitignore` and merges the rules into `AGENTS.md` even when that file is tracked. Hooks stay local even then.
- `crewvane setup --uninstall` removes the kit hooks (restoring a chained hook) and the rules block. Kept `.crewvane/` data stays, and a minimal `.crewvane/` line remains in `.git/info/exclude` so `git status` stays clean. `--purge` deletes `.crewvane/` and removes that line too.

Do not tell the human to commit `.git/hooks`, `.git/info/exclude`, or a local `AGENTS.md`.

## What the command does

Run this in the project directory. Use `crewvane` on `PATH` (the installer links it from `~/.local/bin`). If that command is not found, use `node $HOME/.crewvane/current/cli/bin/crewvane.js` with the same arguments. `current` is a symlink to the installed ref.

```bash
crewvane setup
```

It creates `.crewvane/` (proposals, contracts, packets, e2e index, notify policy, allowlist), records `kit-root` and `node-bin` for the hooks, installs the hooks, then prints a JSON report of what changed and a self-check. Re-running prints `unchanged` where the files already match.

## Always-on rules in the block

- Talk to the human only as the captain. The human need not open worker sessions.
- Do not spawn a worker before the human freezes the contract.
- Stay inside Allowed paths. Never touch Forbidden paths.
- At most 3 workers across all contracts.
- An independent verifier must agree before `needs_review` is filed.
- Only the human merges or ships.
- Never handle passwords, cookies, or storageState contents.
- Route natural-language requests to the matching skills. `/ship-*` commands are optional shortcuts, not steps for the human to memorize. `/ship-inbox <id>` remains a review deep link.

## Hooks

`pre-commit` runs `crewvane check --staged --contract <id>` when `.crewvane/active-contract` names a contract. That check also enforces `.crewvane/hard-rules.json` on the state root. With no active contract, the hook runs `crewvane check --staged --hard-rules` when that file exists, then chains. No contract and no hard-rules file skips the path check, and any chained hook still runs. Hard rules stay in the gitignored `.crewvane/` directory, so they bind this clone only. `pre-push` refuses `main`, `master`, and names listed in `.crewvane/protected-branches`. A human may set `CREWVANE_ALLOW_PROTECTED_PUSH=1`. The captain must not set that variable.

The hooks are plain shell. They call the CLI with `shell` off inside the CLI. They do not talk to GitHub, GitLab, or any other forge.

## 团队手册与经验入口

普通 setup 只建立本地 team 引用。明确采用共享初始化时用 `setup --shared`：
引用已有手册，或创建精简的 `docs/agent-team/handbook.md` 与可版本管理的
`crewvane.team.json`。既有配置和手册不覆盖；不同来源的参数发生冲突时报告给维护者。
已有手册可通过 `--handbook` 指定，经验索引目录可用 `--lessons` 指定。

手册、索引和活动经验由使用方拥有；运行回执留在 `.crewvane/`。
不预填经验，不把整段历史放进 AGENTS.md，不将团队约定写死在安装器中。
工具升级/卸载不改写或删除共享手册、配置和经验。
完整配置和职责见安装包的 `docs/team-and-learning.md`。
