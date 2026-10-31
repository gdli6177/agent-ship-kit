---
name: ship-review
description: >-
  Run /ship-review: present one open inbox item at a time after an independent
  verifier agrees. Use when the human says /ship-review, /ship-inbox, pass,
  changes, or reject, or when a notification deep-links /ship-review <id>.
---

# ship-review

`/ship-review` is how the owner reviews. `/ship-review <id>` jumps to one inbox item, which is also the deep link in notify messages. `/ship-inbox` only lists open items, highest priority first (`agent-ship inbox list --sort priority`). It does not decide.

The human reviews evidence. The captain files it only after the verifier agrees. A worker's summary is not evidence until it points at something the human can open.

## /ship-review

1. If the owner passed an id, load that open item. If it is missing or already decided, say so and stop.
2. Otherwise list open items and sort `priority: high` first.
3. Present ONE item: contract id, allowed and forbidden paths, evidence pointers, the verifier section, and open risks. Do not paste the worker chat.
4. Wait. Map the reply:
   - `pass` or `通过` → `inbox decide <id> accept`
   - `changes` or `要改` plus a reason → `inbox decide <id> changes_requested --note "<reason>"`
   - `reject` or `拒绝` → `inbox decide <id> reject --note "<reason>"`
5. Record the decision, then present the next open item. Stop when the owner says stop or the list is empty.

## Verifier first

Do not file `needs_review` when the worker says it is done. Spawn the read-only verifier in `templates/verifier-prompt.md` with only the frozen contract and the branch. It re-runs acceptance commands, `agent-ship check --contract <id>`, and the relevant E2E smoke. If it disagrees, send the diff back to the worker. The owner does not see that loop.

Copy `templates/review-packet.md` to `.agent-ship/packets/<task_id>.md`.
The event shape is `events/schema.json`. A finished slice is `needs_review`.
Mid-task `blocked` and `needs_approval` items are filed by `ship-dispatch`,
not as review packets. E2E smoke is an evidence row (`ship-e2e`), pointing at
a report, never at a storageState file.

## When to use

- Adapter `collect` returned for a task, or a worker session handed back a write-up.
- The human asks what is waiting on them.
- Someone asks to merge or ship. File or show the packet first. Do not merge.

## Packet

Fill every section of the template.

- Summary: what changed, short enough to check against the diff.
- Evidence table: one row per acceptance line this slice owns. Kind, pointer, result.
- Commands with exit codes, in a fence. "Tests passed" without a command and a pointer does not count.
- What was not run.
- PR, issue, and branch. Opening or linking a PR is allowed. Merging it is not.
- Risks still open.
- Decision requested: `accept`, `changes_requested`, or `reject`. Leave the human's decision blank.

`priority: high` requires both a reason the human asked to be interrupted (or a deadline they set) and at least one evidence URL. Otherwise use `normal`.

## Inbox

From the agent-ship-kit repo:

```bash
cd cli
npm run agent-ship -- inbox add --root .. \
  --type needs_review \
  --title "<slice> is ready for review" \
  --summary "<one paragraph>" \
  --priority normal \
  --source-task-id "<task id>" \
  --evidence "<url>" \
  --pr "<url>" \
  --path ".agent-ship/packets/<task id>.md"
```

Repeat `--evidence` for each pointer, including the E2E report when one ran.
The command prints the event as JSON. Do not hand-edit `inbox.jsonl` if the
CLI is available. `--type` is `needs_review` (the default), `blocked`, or
`needs_approval`.

If the CLI is not installed, write one JSON object with the fields required
for `needs_review`: `id`, `type`, `title`, `summary`, `evidence_urls`,
`priority`, `created_at`, `source_task_id`, `links` (`pr`, `issue`, `path`
as available). Append it as a single line. `id` matches `evt_[A-Za-z0-9_-]+`.

Then use `ship-notify` for the dry-run. Do not ping the human through a
channel this packet invented.

## Human decision

Record the answer on the packet and in the inbox:

```bash
npm run agent-ship -- inbox decide <id> accept|changes_requested|reject --root ..
```

That appends `review_decided` with `subject_id` set to the inbox item.
`inbox list` then hides it. `inbox list --all` still shows the pair.

- `accept` means the evidence matches the frozen contract. It does not merge and does not deploy. Tell the human the branch and PR are ready for whatever their repo usually requires.
- `changes_requested` sends the notes back to the same task if the adapter can continue it. A new spawn needs the human's say-so and still uses the same frozen contract (`ship-dispatch`).
- `reject` stops the slice. Do not respawn it.

## Refusals

- No evidence pointers: do not file `priority: high`. Say what is missing.
- Worker asks the captain to merge "because CI is green": refuse, and show the packet instead.
- Contract text and the diff disagree: file the packet with that risk in the open list, or send it back as not ready. Do not quietly edit the frozen contract.
