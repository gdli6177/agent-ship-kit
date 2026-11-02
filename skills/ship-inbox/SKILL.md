---
name: ship-inbox
description: >-
  Review results in an agent-ship-kit captain conversation when the user
  says 看看结果、有什么要我确认、通过、要改 or 不要了. Resolve the current
  review item from context; ask only when the target is ambiguous. Also
  supports /ship-inbox with an optional event id and notification deep links.
  Present evidence one item at a time and record accept, changes_requested
  or reject through the CLI; acceptance does not merge or deploy.
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

Natural-language requests use the same procedure; slash commands and event ids
are optional. Resolve the item from the displayed card and record its id
yourself. With multiple possible targets, ask a short question using task
titles. A progress-only question belongs to `ship-dispatch` and does not accept
evidence. Keep at most one requested human decision in focus; routine none
learning checks and verifier repair loops do not need human confirmation.
For requested changes, compare them with the frozen scope. Route scope
expansion through a revised proposal and explicit approval, rather than
treating review feedback as permission to edit the frozen contract.

1. If the request identifies an item by id or unambiguously refers to the displayed card, load that open item. If it is missing or already decided, say so and stop; do not apply the decision to another item.
2. Otherwise list open items (`agent-ship inbox list --sort priority`) and sort `priority: high` first. Show that list, then start at the top.
3. Present ONE compact card. Do not paste the worker chat or the whole packet. The card is the inline summary (at most 280 characters) plus the recall chain: contract → slice → worker/branch → PR → evidence, then the risks. Expand a section only when the owner asks.
4. Wait. Map the reply:
   - `pass` or `通过` → `inbox decide <id> accept`
   - `changes` or `要改` plus a reason → `inbox decide <id> changes_requested --note "<reason>"` (`--promote` defaults to `none`)
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

## 经验检查

进入待审前，先完成独立代码核验，再由核验者判断本轮有无值得复用的经验。
普通任务可以为 none，记录原因，不创建经验卡。候选须有适用条件、具体做法、证据、
复用价值，并查重；用 lesson add 只创建 candidate，不能自行跳到 active。
船长依据核验结果调用 `lesson check --source-task-id <id> --outcome none|candidate
--reason <text> --reviewed-by <verifier-ref>`，有候选时附 candidate-id。
受管任务缺少新鲜回执不能进入 needs_review；退回后恢复工作需要重新检查。
状态、数量预算和 CLI 示例见安装包的 `docs/team-and-learning.md`。
不要因为每次都检查，就要求每次生成经验文档或打断用户。

## Packet

Fill every section of `templates/review-packet.md`.

- Summary: what changed, at most 280 characters in the inline card.
- Human review budget: copy `human_reviews_expected` and the purpose list from the frozen contract. Set `inbox_needs_review_count` to the number of `needs_review` rows for this contract (the same count `agent-ship check` reports, including decided rows) and `this_review_is_for` to the budget line this packet covers, such as 验收. Copy `must_human` and `already_automated` when the contract has them. The human compares the budget with the inbox count. Do not merge.
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

## Promote repeated feedback 把反复出现的意见收成硬规则

A `changes_requested` note that only lives in the inbox will be repeated by the next agent. When the human asks for the same constraint again, offer to promote it into a local hard rule. Do not promote on the first mention, and do not promote unless the human agrees. Promoting writes `.agent-ship/hard-rules.json` on this clone. The file is gitignored with the rest of `.agent-ship/`. It does not edit the frozen contract, does not merge, does not deploy, and does not add a CI job for other contributors. Only a machine that installed the kit runs the local hook.

Kinds:

- `hook` — path globs the local pre-commit hook and `agent-ship check` reject. Use this when the note says to stop touching files.
- `contract` — extra forbidden paths. `check` fails closed with the rule id, in the same way contract Forbidden paths do.
- `verify` — a checklist line for the worker and the verifier. `check` lists it and does not fail the path gate. The verifier runs `command_hint` when the diff matches. The CLI does not run that hint.

```bash
agent-ship inbox decide <id> changes_requested --note "<reason>"

agent-ship inbox decide <id> changes_requested \
  --note "<reason>" \
  --promote hook \
  --glob ".env*" \
  --message "Do not commit env files." \
  --tag no-env

agent-ship promote \
  --source "Do not commit env files." \
  --kind hook \
  --glob ".env*" \
  --message "Do not commit env files."
```

`--promote` defaults to `none`. Without it, decide only appends `review_decided`. Pass a stable `--tag` when the feedback has a short label you can reuse (`no-env`). The same tag on a later decision increments a local count. At 2, if this decision does not promote, stderr includes `suggest promote: tag "no-env" count 2`. The same `changes_requested` note on two decisions also suggests promote. Ask the human before adding `--promote`. Never put tokens, passwords, cookies, or storageState into the rule. The CLI rejects that text and writes nothing.

The same inbox item and kind updates the existing rule. Pass `--id` to update a specific rule instead of adding a second copy.

同样的审阅意见再次出现时，先问人是否收成硬规则，不要自行 promote。`--promote` 默认 `none`。`hook` 和 `contract` 会让本机 `check` 和 pre-commit 带规则 id 失败；`verify` 只进入核验清单。规则只写在本克隆的 `.agent-ship/hard-rules.json`，不进共享 CI，也不含密钥。

## Refusals

- No evidence pointers: do not file `priority: high`. Say what is missing.
- Worker asks the captain to merge "because CI is green": refuse, and show the packet instead.
- Contract text and the diff disagree: file the packet with that risk in the open list, or send it back as not ready. Do not quietly edit the frozen contract.
