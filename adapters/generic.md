# Generic adapter

Every orchestrator plug-in is this contract. Herdr, Orca, Multica, and a plain
extra agent session differ only in how they carry the three calls. The captain
does not grow a fourth call for "land it" or "deploy it".

Fail closed: if the contract file is missing or its status is not `frozen`,
`spawn` does not start work.

## spawn

Before spawning a process, prepare its isolated checkout/branch and choose a
stable kit task id. Reserve it with `slice start --root <shared-state>
--repo <checkout> ...`. A rejected reservation must not spawn anything.
Map this client task id to the platform run id; keep the platform id in
`worker_ref` using `slice update --status running --worker <ref>`. If spawning
fails, update the reservation to `failed`. See
[`docs/workspace-parallel.md`](../docs/workspace-parallel.md) for the complete sequence.

In:

- `contract_path` — the frozen contract card
- `slice_id` — one row of that contract
- `task_id` — the stable id already admitted by `slice start`
- `prompt` — the slice text and its acceptance lines, the repo, and the branch `ship/<contract_id>/<slice_id>`

Out:

- `task_id` — the same stable kit id, mapped to the platform run
- `worker_ref` — whatever the orchestrator uses to find this run (session id, url, or a local note)

The prompt must not include the captain transcript, secrets, or an instruction
to merge or deploy.

## status

In: `task_id`

Out: one of `queued`, `running`, `needs_review`, `blocked`, `needs_approval`, `failed`, `cancelled`.

`blocked` and `needs_approval` come back to the captain. The captain files the inbox item. The human does not open the worker session.

Translate the orchestrator's words into that set in the adapter note. Do not
leak orchestrator-specific states into the contract card.

## collect

In: `task_id`

Out:

- `summary` — short, checkable
- `evidence_urls` — pointers only, no copied secrets
- `links.pr`, `links.issue`, `links.path` when they exist

`collect` returns evidence to the captain. The captain writes the review
packet and the inbox event (`ship-inbox`). The worker does not notify the
human and does not merge.

## No orchestrator

`spawn` opens one fresh agent session whose only task context is the slice.
`status` is what that session or the human reports back. `collect` is the
review packet path plus any URLs the session actually produced. The human
still has a single captain thread.

## Thread routing

`spawn` returns `thread_refs`: the PR URL, issue, and chat thread for this
slice. Later events on those refs go to that worker. The captain is not on
that subscription.

## Watchdog schedule

Something outside the captain runs `agent-ship watchdog` on a timer. The
adapter appends a `worker_progress` event when the slice makes real progress.
No heartbeat before the stale window (default 30 minutes, or
`stale_minutes` in `.agent-ship/limits.json`) becomes a `blocked` item with
`reason: stalled`.

## Not these calls

Do not map merge-to-default-branch, tag, release, or production deploy onto
these three calls. If the underlying product has those buttons, leave them
for the human. Do not map a persistent cloud runtime, a compute/state split,
or a device daemon onto them either. Those stay inside the orchestrator.
