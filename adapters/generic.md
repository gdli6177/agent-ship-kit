# Generic adapter

Every orchestrator plug-in is this contract. Herdr, Orca, Multica, and a plain
extra agent session differ only in how they carry the three calls. The captain
does not grow a fourth call for "land it" or "deploy it".

Fail closed: if the contract file is missing or its status is not `frozen`,
`spawn` does not start work.

## spawn

In:

- `contract_path` — the frozen contract card
- `slice_id` — one row of that contract
- `prompt` — the slice text and its acceptance lines, the repo, and the branch `ship/<contract_id>/<slice_id>`

Out:

- `task_id` — stable id the captain stores as `source_task_id`
- `worker_ref` — whatever the orchestrator uses to find this run (session id, url, or a local note)

The prompt must not include the captain transcript, secrets, or an instruction
to merge or deploy.

## status

In: `task_id`

Out: one of `queued`, `running`, `needs_review`, `failed`, `cancelled`.

Translate the orchestrator's words into that set in the adapter note. Do not
leak orchestrator-specific states into the contract card.

## collect

In: `task_id`

Out:

- `summary` — short, checkable
- `evidence_urls` — pointers only, no copied secrets
- `links.pr`, `links.issue`, `links.path` when they exist

`collect` returns evidence to the captain. The captain writes the review
packet and the inbox event (`ship-review`). The worker does not notify the
human and does not merge.

## No orchestrator

`spawn` opens one fresh agent session whose only task context is the slice.
`status` is what that session or the human reports back. `collect` is the
review packet path plus any URLs the session actually produced. The human
still has a single captain thread.

## Non-calls

Do not map merge-to-default-branch, tag, release, or production deploy onto
these three calls. If the underlying product has those buttons, leave them
for the human.
