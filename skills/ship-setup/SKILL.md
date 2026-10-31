---
name: ship-setup
description: >-
  Initialize one clone for agent-ship-kit with /ship-setup. Use when the human
  asks to set up, init, or uninstall the kit, or when AGENTS.md, local hooks,
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

From the agent-ship-kit checkout:

```bash
cd cli
npm run agent-ship -- setup --root <project>
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
- Use `/ship-setup`, `/ship-inbox`, `/ship-review`, `/ship-contract`, `/ship-dispatch`, `/ship-notify`, and `/ship-e2e`.

## Hooks

`pre-commit` runs `agent-ship check --staged --contract <id>` when `.agent-ship/active-contract` names a contract. No active contract means the path check is skipped and any chained hook still runs. `pre-push` refuses `main`, `master`, and names listed in `.agent-ship/protected-branches`. A human may set `AGENT_SHIP_ALLOW_PROTECTED_PUSH=1`. The captain must not set that variable.

The hooks are plain shell. They call the CLI with `shell` off inside the CLI. They do not talk to GitHub, GitLab, or any other forge.
