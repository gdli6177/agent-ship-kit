# agent-ship CLI

Local inbox and notify dry-run for the captain. Node 20 or newer. The only
dependency is `tsx`, used to run TypeScript directly.

This CLI appends JSONL under `.agent-ship/` and prints a notification plan.
It does not start a shell, does not run the planned command, and does not
merge or deploy.

## Setup

```bash
cd cli
npm install
```

## Commands

Run from `cli/` so the example policy paths resolve. `--root ..` writes the
inbox at the repo's `.agent-ship/inbox.jsonl`.

```bash
npm run agent-ship -- inbox add --root .. \
  --title "Auth middleware ready" \
  --summary "Contract checks passed on the slice branch." \
  --priority high \
  --source-task-id task_auth_mw \
  --evidence https://ci.example/runs/1001 \
  --pr https://example.com/pull/12 \
  --path .agent-ship/packets/task_auth_mw.md

npm run agent-ship -- inbox list --root ..
npm run agent-ship -- inbox list --root .. --json --priority high

npm run agent-ship -- notify dry-run --root .. --latest \
  --policy ../templates/notify.policy.example.md \
  --allowlist ../templates/notify.allowlist.example.json
```

`inbox add` prints the `needs_review` event. `notify dry-run` prints a plan
with `executed: false`. Exit 0 means the plan was produced, including a plan
that denies the action. Exit 1 means the arguments, policy, allowlist, or
inbox could not be read.

Pass `--event file.json` instead of `--latest` to plan a specific event.
`--help` prints the flag list.

There is no `notify run` subcommand.

## Safety

- Allowlist patterns are argv templates. See `docs/ARCHITECTURE.md`.
- Shell metacharacters, shells, and `sudo` are rejected.
- `$VARS` are not expanded, so secrets are not pulled from the environment.
- A high-priority item with no `--evidence` is still stored, and the CLI warns on stderr. The review skill treats that as not ready to interrupt the human.

## Tests

```bash
cd cli
npm test
npm run typecheck
```

`npm test` uses `node:test` via `tsx`. The tests cover inbox append/list,
the example policy dry-run, allowlist denials, and the CLI entrypoint.
