---
name: ship-dispatch
description: >-
  Spawn on-demand workers for slices of a frozen contract, under that
  contract's parallel cap, via a thin orchestrator adapter. Use when a
  contract is frozen, when deciding whether a worker may start, or when
  mapping spawn onto Herdr, Orca, Multica, or a plain extra agent session.
---

# ship-dispatch

Dispatch is a gate in front of whatever orchestrator the human already uses.
This skill does not schedule a fleet, does not keep a worker roster, and does
not merge or deploy.

The adapter contract is `adapters/generic.md`. If the human named Herdr, Orca,
or Multica, also read the short note under `adapters/` for that system. The
kit calls stay `spawn`, `status`, and `collect`.

## Preconditions (all required)

- A contract file exists and its status is exactly `frozen`.
- The human froze it (see `ship-contract`). A draft proposal is not enough.
- The slice id is a row in that contract.
- That slice has no `running` task, unless the human explicitly asked to
  replace a `failed` or `cancelled` one.
- Spawning it would not exceed `max_parallel` for this contract.

If any line fails, do not spawn. Tell the human which line failed.

## Parallel cap

- Read `max_parallel` from the contract. If the field is missing, use 3 and
  say you are using the default.
- Count slices of this contract whose latest adapter status is `queued` or
  `running`.
- If the count is already at the cap, leave the extra slice unspawned and say
  so. Do not raise the cap. Do not queue it inside an orchestrator the human
  did not ask you to use.
- There is no pre-built roster. Not spawning idle workers is the normal case.

## Spawn

1. Build the worker prompt from the contract slice only: goal of that slice,
   the acceptance lines it owns, the repo, and the branch name
   `ship/<contract_id>/<slice_id>`. Do not attach the captain chat, tokens, or
   "merge when green" / "deploy when green".
2. Call adapter `spawn` with the contract path, slice id, and that prompt.
   Fail closed if the adapter cannot show that the contract is frozen.
3. Record `task_id` and `worker_ref` on the contract's dispatch log. Appending
   a log row is not editing the frozen terms.
4. The worker's job ends at a review packet. Notification is `ship-notify`,
   after `ship-review`, not a step the worker runs.

## While work is in flight

- Poll adapter `status` when the human asks, or when you are about to file a
  review. Do not busy-loop.
- Map foreign states onto `queued`, `running`, `needs_review`, `failed`, or
  `cancelled` (see `templates/e2e-conventions.md`).
- On `failed` or `cancelled`, report the adapter's reason. Do not spawn a
  replacement unless the human asks.
- `status` and `collect` never include a merge or a production deploy. If the
  orchestrator offers those operations, do not call them.

## No-orchestrator path

When the human is not using Herdr, Orca, or Multica, `spawn` means one fresh
agent session whose only task context is the slice. You are still the only
agent in the human's thread. Do not pretend that session is a standing worker.

## Handoff

When `collect` returns evidence, or the worker session posts a packet, stop
dispatching and use `ship-review`.
