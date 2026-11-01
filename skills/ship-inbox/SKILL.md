---
name: ship-inbox
description: >-
  Slash command /ship-inbox. The skill name is ship-inbox, matching that
  command, so Cursor, Claude Code, and similar hosts load this file when the
  human types /ship-inbox or /ship-inbox <id>. With no id, list open items
  by priority and review them one at a time. With an id, jump to that item.
  The owner replies pass, changes plus a reason, or reject. Record the
  decision with the agent-ship inbox decide CLI. Also use when a notification
  deep-links /ship-inbox <id>.
---

# ship-inbox

`/ship-inbox` is how the owner sees and reviews the queue. With no id, list
open items sorted by priority (high first), then review them one at a time.
`/ship-inbox <id>` jumps straight to that item. Notify messages use that deep
link. The CLI subcommands stay `inbox list` and `inbox decide`.

The captain files an item only after the verifier agrees. A worker's summary
is not evidence until it points at something the human can open. Templates
live in the kit at `$HOME/.agent-ship-kit/current/templates/`.

## /ship-inbox

1. If the owner passed an id, load that open item. If it is missing or already decided, say so and stop.
2. Otherwise list open items (`agent-ship inbox list --sort priority`) and sort `priority: high` first. Show that list, then start at the top.
3. Present ONE compact card. Do not paste the worker chat or the whole packet. The card is the inline summary (at most 280 characters) plus the recall chain: contract → slice → worker/branch → PR → evidence, then the risks. Expand a section only when the owner asks.
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
- The human asks what is waiting on them, or says `/ship-inbox`.
- Someone asks to merge or ship. File or show the packet first. Do not merge.

## Packet

Fill every section of `templates/review-packet.md`.

- Summary: what changed, at most 280 characters in the inline card.
- Evidence table: one row per acceptance line this slice owns. Kind, pointer, result.
- Commands with exit codes, in a fence. "Tests passed" without a command and a pointer does not count.
- What was not run.
- PR, issue, and branch. Opening or linking a PR is allowed. Merging it is not.
- Risks still open.
- Decision requested: `accept`, `changes_requested`, or `reject`. Leave the human's decision blank.

`priority: high` requires both a reason the human asked to be interrupted (or a deadline they set) and at least one evidence URL. Otherwise use `normal`.

## Inbox CLI

These are CLI subcommands, not the `/ship-inbox` name. Run them in the project directory. Use `agent-ship` on `PATH`. If that command is not found, use `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js` with the same arguments.

```bash
agent-ship inbox add \
  --type needs_review \
  --title "<slice> is ready for review" \
  --summary "<one paragraph, at most 280 characters>" \
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

Then use `ship-notify` for the dry-run. The push text includes `/ship-inbox <id>`.

## Human decision

Record the answer on the packet and in the inbox:

```bash
agent-ship inbox decide <id> accept|changes_requested|reject
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
