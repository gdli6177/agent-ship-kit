---
name: ship-review
description: >-
  Build a needs_review evidence packet and inbox event from a worker's
  returned proof. Use when a slice finishes, when filing a review for the
  human, or when someone asks whether a change is ready to merge.
---

# ship-review

The human reviews evidence. The captain files it. A worker's summary is not
evidence until it points at something the human can open.

Copy `templates/review-packet.md` to `.agent-ship/packets/<task_id>.md`.
The event shape is `events/schema.json`, type `needs_review`.

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
  --title "<slice> is ready for review" \
  --summary "<one paragraph>" \
  --priority normal \
  --source-task-id "<task id>" \
  --evidence "<url>" \
  --pr "<url>" \
  --path ".agent-ship/packets/<task id>.md"
```

Repeat `--evidence` for each pointer. The command prints the `needs_review`
event as JSON. Do not hand-edit `inbox.jsonl` if the CLI is available.

If the CLI is not installed, write one JSON object with the fields required
for `needs_review`: `id`, `type`, `title`, `summary`, `evidence_urls`,
`priority`, `created_at`, `source_task_id`, `links` (`pr`, `issue`, `path`
as available). Append it as a single line. `id` matches `evt_[A-Za-z0-9_-]+`.

Then use `ship-notify` for the dry-run. Do not ping the human through a
channel this packet invented.

## Human decision

Record the answer on the packet and, when you write an event by hand, as
`type: review_decided` with `decision` set to `accept`, `changes_requested`,
or `reject`.

- `accept` means the evidence matches the frozen contract. It does not merge and does not deploy. Tell the human the branch and PR are ready for whatever their repo usually requires.
- `changes_requested` sends the notes back to the same task if the adapter can continue it. A new spawn needs the human's say-so and still uses the same frozen contract (`ship-dispatch`).
- `reject` stops the slice. Do not respawn it.

## Refusals

- No evidence pointers: do not file `priority: high`. Say what is missing.
- Worker asks the captain to merge "because CI is green": refuse, and show the packet instead.
- Contract text and the diff disagree: file the packet with that risk in the open list, or send it back as not ready. Do not quietly edit the frozen contract.
