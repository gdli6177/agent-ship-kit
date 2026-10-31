# agent-ship CLI

Local inbox and notify for the captain. Node 20 or newer. The only
dependency is `tsx`, used to run TypeScript directly.

This CLI appends JSONL under `.agent-ship/`. `notify dry-run` prints a plan.
`notify run` starts an allowlisted argv with no shell. It does not merge or
deploy.

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
npm run agent-ship -- inbox list --root .. --all --json

npm run agent-ship -- inbox decide evt_<id> accept --root .. --note "Evidence matches."

npm run agent-ship -- notify dry-run --root .. --latest \
  --policy ../templates/notify.policy.example.md \
  --allowlist ../templates/notify.allowlist.example.json
```

`inbox add` defaults to `needs_review`. `--type blocked` and
`--type needs_approval` are the mid-task inbox. `inbox list` shows open items
only; `--all` includes `review_decided` rows. `inbox decide` appends the
decision and the item drops off the open list.

`notify dry-run` prints a plan with `executed: false` and exits 0 even when
`allow` is false. A normal review matches no push rule (pull). A high review
with evidence matches `high priority page`. A high review with no evidence
URLs is not paged.

`notify run` uses the same flags. It executes the argv only when `allow` is
true, with `shell: false`. A refusal exits 1 and starts nothing. `--action`
is the captain's reading of the policy's free-text section; the allowlist
still applies.

Pass `--event file.json` instead of `--latest` to plan a specific event.
`--help` prints the flag list.

## Safety

- Allowlist patterns are argv templates. See `docs/ARCHITECTURE.md`.
- Shell metacharacters, shells, and `sudo` are rejected.
- `$VARS` are not expanded, so secrets are not pulled from the environment.
- A high-priority `needs_review` with no `--evidence` is still stored, the CLI warns on stderr, and notify refuses to page it.
- `blocked` and `needs_approval` may notify without evidence URLs. The example action is `multica issue create --assignee me ...`, not `multica *`.

## Tests

```bash
cd cli
npm test
npm run typecheck
```

`npm test` uses `node:test` via `tsx`. The tests cover the open inbox,
`inbox decide`, the pull-by-default policy, the empty-evidence refusal, and
`notify run` against an allowlisted argv (no shell).
