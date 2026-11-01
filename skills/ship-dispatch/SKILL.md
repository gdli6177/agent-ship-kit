---
name: ship-dispatch
description: >-
  Slash command /ship-dispatch. The skill name is ship-dispatch, matching
  that command, so hosts that support skills load this file when the human
  types /ship-dispatch. Spawn on-demand workers for a frozen contract under
  the global cap and max_parallel, and record the slice with agent-ship
  slice start. Also use when a contract is frozen, when a worker is blocked
  or needs approval, or when mapping spawn onto Herdr, Orca, Multica, or a
  plain extra agent session.
---

# ship-dispatch

The captain is a router, not an executor. Dispatch is a gate in front of
whatever orchestrator the human already uses. This skill does not schedule a
fleet, does not keep a worker roster, and does not merge or deploy. Templates
and adapters live in the kit at `$HOME/.agent-ship-kit/current/`.

## Router

The captain talks to the owner, drafts contracts, dispatches slices, routes
events, and records decisions. It does not edit product code and it does not
run the long task itself, including work that looks small. Prompt-only
delegation is unreliable: the same context that holds the plan will start
implementing. The frozen contract is the handoff.

Do not block waiting on a worker. Accept the owner's next request while
slices run. Ask the adapter for status when you need it; do not sit in the
worker session.

## Thread subscription

Every dispatched slice records `contract_id`, `slice_id`, and `thread_refs`
(PR URL, issue, chat thread) on its `worker_dispatched` event in
`.agent-ship/events.jsonl`. Follow-up events on a subscribed thread — PR
review comments, CI results, chat replies — go straight to the owning worker.
The captain handles only new or unowned events, and coordination that crosses
slices. Append a `worker_progress` heartbeat when the worker reports real
progress; that is what `/ship-watchdog` reads.

The adapter contract is `adapters/generic.md`. If the human named Herdr, Orca,
or Multica, also read the short note under `adapters/` for that system. The
kit calls stay `spawn`, `status`, and `collect`.

## Preconditions (all required)

- A contract file exists and its status is exactly `frozen`.
- The human froze it (see `ship-contract`). A draft proposal is not enough.
- The slice id is a row in that contract.
- That slice has no `running` task, unless the human explicitly asked to
  replace a `failed` or `cancelled` one.
- The contract has non-empty Allowed paths and Forbidden paths.
- Spawning it would not exceed this contract's `max_parallel`.
- Spawning it would not exceed the global cap (default 3 across every
  contract). See `templates/workflow.md`.

If any line fails, do not spawn. Tell the human which line failed.

## Parallel caps

- Global cap: count the latest dispatch-log row of every contract under
  `.agent-ship/contracts/` whose status is `queued` or `running`. The ceiling
  is `global_max_parallel` in `.agent-ship/limits.json` when the human put a
  positive integer there, otherwise 3. Do not raise it yourself.
- Contract cap: read `max_parallel` from this contract. If the field is
  missing, use 3 and say so. If it is higher than the global cap, treat the
  global cap as the real ceiling and say so.
- A new worker has to fit under both remainders. If either count is already
  at its cap, leave the slice unspawned. Do not queue it inside an
  orchestrator the human did not ask you to use.
- There is no pre-built roster. Not spawning idle workers is the normal case.

## Spawn

1. Build the worker prompt from the contract slice only: goal of that slice,
   the acceptance lines it owns, Allowed paths, Forbidden paths, the repo,
   and the branch name `ship/<contract_id>/<slice_id>`. Copy both path lists
   verbatim. Do not attach the captain chat, tokens, or "merge when green" /
   "deploy when green". If either path list is missing, stop and send the
   contract back through `ship-contract`.
2. Call adapter `spawn` with the contract path, slice id, and that prompt.
   Fail closed if the adapter cannot show that the contract is frozen.
3. Record `task_id` and `worker_ref` on the contract's dispatch log. Appending
   a log row is not editing the frozen terms. Write the contract id to
   `.agent-ship/active-contract` so the local pre-commit hook checks this
   contract. That file is local to the clone.
4. Record the slice and arm the watchdog timer. This installs a user-level
   cron snippet and launchd plist outside the repo the first time a slice is
   open. Later slices leave the timer in place.

Run this in the project directory. Use `agent-ship` on `PATH`. If that command is not found, use `"$HOME/.agent-ship-kit/current/cli/bin/agent-ship.js"` with the same arguments.

```bash
agent-ship slice start \
  --contract <contract_id> --slice <slice_id> \
  --source-task-id <task_id> --title "<slice>" --summary "<one line>" \
  --worker <worker_ref> --branch ship/<contract_id>/<slice_id>
```
5. The worker returns evidence or an escalation to the captain. It does not
   notify the human. Notification is `ship-notify`, after the captain has
   filed an inbox item.

## While work is in flight

- Poll adapter `status` when the human asks, or when you are about to file a
  review. Do not busy-loop.
- Map foreign states onto `queued`, `running`, `needs_review`, `blocked`,
  `needs_approval`, `failed`, or `cancelled` (see `templates/workflow.md`).
  Append a dispatch-log row when the status changes. The latest row for a
  task id is the one that counts.
- On `failed` or `cancelled`, report the adapter's reason. Do not spawn a
  replacement unless the human asks.
- `status` and `collect` never include a merge or a production deploy. If the
  orchestrator offers those operations, do not call them.

## Escalation

The owner never opens a worker session. If the worker is stuck or needs a
mid-task decision, it returns a short note to the captain through `collect`
(or the session result). The captain then:

1. Tells the owner in the captain thread, in a few sentences, what is blocked
   and which contract paths are involved.
2. Files the inbox item:

```bash
agent-ship inbox add \
  --type blocked \
  --title "<one line>" \
  --summary "<what the owner must decide>" \
  --source-task-id "<task id>" \
  --path ".agent-ship/contracts/<contract_id>.md"
```

Use `--type needs_approval` when the worker can continue after a yes or no
(for example a path that is not on the allow list). Use `blocked` when it
cannot continue at all (captcha, missing test account, failing login).

3. Waits for `inbox decide <id> accept|changes_requested|reject`. Relays that
   decision back to the same worker. Does not spawn a replacement unless the
   decision says to and both parallel caps still allow it.

Do not hand the owner a worker transcript to read.

## No-orchestrator path

When the human is not using Herdr, Orca, or Multica, `spawn` means one fresh
agent session whose only task context is the slice. You are still the only
agent in the human's thread. Do not pretend that session is a standing worker.

## Handoff

When the worker reports done, do not file the inbox and do not call `/ship-inbox` yet.

1. Spawn a separate read-only verifier. Its only prompt is `templates/verifier-prompt.md` plus the frozen contract path and the branch name. Do not attach the worker chat.
2. The verifier re-runs the acceptance commands, `agent-ship check --contract <id>`, and any E2E smoke the contract requires.
3. If the verifier disagrees, send that result back to the same worker. Do not tell the owner.
4. If the verifier agrees, fill the packet's Verifier section and hand off to `ship-inbox`, which files `needs_review`. The notify text includes `/ship-inbox <id>`.
