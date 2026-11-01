# Delivery workflow 交付流程

One person, one captain thread, from intake to ship. The captain routes and does not execute the slice, even when the edit looks small, and does not wait out a worker before taking the next request. Workers exist only as
adapter tasks spawned from a frozen contract. Nothing in this loop merges to
main or deploys to production.

Browser login and smoke tests are not this file. Those live in
[e2e.md](e2e.md) and [e2e-testing.md](e2e-testing.md), and the captain follows
`skills/ship-e2e/SKILL.md`.

## Local layout

Filled-in cards stay on the machine. The repo keeps templates, not runtime state.

```text
.agent-ship/
  inbox.jsonl                 # attention events and review_decided lines
  proposals/<proposal_id>.md  # copy of templates/proposal-card.md
  contracts/<contract_id>.md  # copy of templates/contract-card.md
  packets/<task_id>.md        # copy of templates/review-packet.md
  e2e/                        # storageState and the filled login index; gitignored
  limits.json                 # optional { "global_max_parallel": N }; gitignored
```

`inbox.jsonl`, the card directories, `.agent-ship/e2e/`, and `limits.json` are
gitignored. `.agent-ship/.gitkeep` is the only committed marker.

## Identifiers

| Id | Where it comes from | Used as |
| --- | --- | --- |
| `proposal_<slug>` | captain, while drafting | the one current proposal |
| `contract_<slug>` | captain, at freeze | contract card; slices cite it |
| `<slice_id>` | contract table | one worker |
| task id | chosen before CLI admission, mapped by adapter `spawn` | `source_task_id`, packet filename |
| `evt_<...>` | inbox CLI | event `id` |

Slugs are lowercase ascii, digits, and hyphens.

## Status words

| Word | Means |
| --- | --- |
| `draft` | The one current proposal. Not dispatchable. |
| `superseded` | An older proposal. Not a choice. |
| `frozen` | Human has accepted this contract text. Dispatchable. Immutable. |
| `queued` / `running` | Adapter states. Count toward both caps below. |
| `needs_review` | Evidence is in the inbox. Waiting on the human. |
| `blocked` | Worker cannot continue. Owner answers via the captain. |
| `needs_approval` | Worker needs a mid-task decision. Same path as blocked. |
| `failed` / `cancelled` | Tell the human. Do not silently replace the worker. |
| `accept` / `changes_requested` / `reject` | Human decisions recorded with `inbox decide`. `accept` is not a merge. |

## Parallel caps

Two ceilings, both defaulting to 3. The captain does not raise either one.

- **Global:** at most `global_max_parallel` workers in `queued` or `running`
  across every contract. Default 3. If `.agent-ship/limits.json` exists and
  its `global_max_parallel` is a positive integer, use that number when the
  human set it; otherwise use 3.
- **Per contract:** `max_parallel` on the contract card. Default 3. It must
  not be higher than the global cap. The human may set it lower.

Use the shared CLI event/inbox running view per task id; the Markdown dispatch log is an audit view. Reserve with `slice start` before adapter spawn. A new spawn has to fit under
both the contract's remaining slots and the global remaining slots.

## Discussion and freeze

While the proposal is `draft`, the captain talks freely and keeps that one
card current. Each round appends a "What changed 本轮变更" note. Do not put a
second proposal in front of the human.

The contract file is written only after an explicit freeze:

- "freeze"
- "冻结合同"
- a sentence that names the proposal id and accepts that exact text

"Looks good" without a proposal id is not a freeze. Silence is not a freeze.

Changing a frozen contract does not edit that file. The captain stops the slices the change affects, drafts a new id with `Supersedes` pointing at the old one, and waits for another freeze. Finished work the new text does not touch is kept.

## One slice, one branch, one packet

- Branch from the repo's default integration branch.
- Branch name: `ship/<contract_id>/<slice_id>`.
- One pull request per slice. Opening a PR is not merging it.
- The review packet links that PR. The human merges, outside this kit, after
  `accept`.
- The worker prompt includes Allowed paths and Forbidden paths from the contract.

## Order of operations

1. Intake stays in the captain thread. Keep one proposal card current.
2. Stop on open questions that change acceptance or the path lists.
3. Human freezes. Write the contract card with status `frozen`.
4. Dispatch only while both parallel caps allow it.
5. If a worker is blocked or needs a mid-task decision, the captain files
   `inbox add --type blocked` or `--type needs_approval`. The owner does not
   open the worker session. `inbox decide` records the answer; the captain
   relays it.
6. When a worker reports done, a separate read-only verifier sees only the
   frozen contract and the branch (`templates/verifier-prompt.md`). It re-runs
   acceptance, `agent-ship check`, and relevant E2E smoke. Disagreement goes
   back to the worker, not to the owner.
7. On agreement, the captain writes the review packet, including the verifier
   section and E2E rows, and `inbox add`s a `needs_review` event.
8. Normal items are pull: they sit in `/ship-inbox`. `notify dry-run` before
   any push. The message includes `/ship-inbox <id>`. `notify run` only when
   the plan says `allow: true`. High priority with empty `evidence_urls` does
   not page.
9. The owner reviews with `/ship-inbox` (or `/ship-inbox <id>` from a
   notification): one item at a time, then `inbox decide`. The default list
   then hides that item.
10. On `changes_requested`, continue the same task if the adapter allows it.
    A changed contract is a new contract id.
11. Merge or release happens only when the human does it with their own tools.

## Evidence bar

A finished `needs_review` includes at least one evidence URL or path, the
task id, and `links.path` to the packet. E2E smoke is an evidence row pointing
at a report, never at a storageState file. `priority: high` with an empty
`evidence_urls` array is a draft. The CLI warns on add and refuses to page it.

## No secrets

Do not write tokens, `.env` values, passwords, or storageState contents into
cards, events, policies, allowlists, or the captain thread. An evidence URL
may point at a CI page the human can already open.

多仓库与 worktree：共享状态根目录、执行 checkout、原子名额预留和显式恢复见 [工作空间接入说明](../docs/workspace-parallel.md)。
