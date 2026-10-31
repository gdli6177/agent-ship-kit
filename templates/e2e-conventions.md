# End-to-end conventions

One person, one captain thread, from intake to ship. Workers exist only as
adapter tasks spawned from a frozen contract. Nothing in this loop merges to
main or deploys to production.

## Local layout

Filled-in cards stay on the machine. The repo keeps templates, not runtime state.

```text
.agent-ship/
  inbox.jsonl                 # needs_review events, one JSON object per line
  proposals/<proposal_id>.md  # copy of templates/proposal-card.md
  contracts/<contract_id>.md  # copy of templates/contract-card.md
  packets/<task_id>.md        # copy of templates/review-packet.md
```

`inbox.jsonl` and those three directories are gitignored. `.agent-ship/.gitkeep`
is the only committed marker.

## Identifiers

| Id | Where it comes from | Used as |
| --- | --- | --- |
| `proposal_<slug>` | captain, while drafting | proposal card and `proposal_ready.source_task_id` |
| `contract_<slug>` | captain, at freeze | contract card; slices cite it |
| `<slice_id>` | contract table | one worker |
| task id | adapter `spawn` | `source_task_id`, packet filename |
| `evt_<...>` | inbox CLI, or the captain if writing JSON by hand | event `id` |

Slugs are lowercase ascii, digits, and hyphens.

## Status words

| Word | Means |
| --- | --- |
| `draft` | Proposal only. Not dispatchable. |
| `frozen` | Human has accepted this contract text. Dispatchable. Immutable. |
| `queued` / `running` | Adapter states. Not an excuse to spawn past `max_parallel`. |
| `needs_review` | Evidence is in the inbox. Waiting on the human. |
| `failed` / `cancelled` | Tell the human. Do not silently replace the worker. |
| `accept` / `changes_requested` / `reject` | Human decisions. `accept` is not a merge. |

## Freeze

The captain may draft, revise, and recommend. The contract file is written
only after the human freezes it. Phrases that count:

- "freeze"
- "冻结合同"
- a sentence that names the proposal id and clearly accepts that text

"Looks good, keep going" without a proposal id is not a freeze. Silence is
not a freeze. The captain asking itself is not a freeze.

## One slice, one branch, one packet

- Branch from the repo's default integration branch.
- Branch name: `ship/<contract_id>/<slice_id>`.
- One pull request per slice, opened by the worker or the captain as a draft
  or ordinary PR. Opening a PR is not merging it.
- The review packet links that PR. The human merges, outside this kit, after
  `accept`, using the repo's normal review rules.
- Do not stack a second slice onto a branch the human has not accepted.

## Order of operations

1. Intake stays in the captain thread. Capture a proposal card.
2. Stop on open questions that change acceptance.
3. Human freezes. Write the contract card with status `frozen`.
4. Dispatch up to `max_parallel` slices through the adapter. Default ceiling
   in the contract template is 3. The captain does not raise it.
5. Each worker returns evidence for its slice only.
6. Captain writes the review packet and `inbox add`s a `needs_review` event.
7. `notify dry-run` against the policy and allowlist. Show the plan. Do not
   invent a shell command the plan did not print.
8. Human decides. Captain records `review_decided`.
9. On `changes_requested`, the same worker task continues if the adapter
   allows it; otherwise the human must agree before a new spawn. The frozen
   contract still applies. A changed contract is a new contract id.
10. Ship, meaning merge or release, happens only when the human does it with
    their own tools.

## Evidence bar

A `needs_review` event for a finished slice includes at least one evidence
URL or path the human can open, the task id, and the packet path in `links.path`.
`priority: high` with an empty `evidence_urls` array is a draft, not an
interrupt. The CLI warns on that case.

## No secrets

Do not write tokens, `.env` values, or production credentials into cards,
events, policies, or allowlists. An evidence URL may point at a CI page the
human can already open.
