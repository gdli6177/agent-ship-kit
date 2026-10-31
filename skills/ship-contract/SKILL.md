---
name: ship-contract
description: >-
  Turn a captain intake into a proposal card and, only after an explicit human
  freeze, into an immutable contract card. Use when drafting a 方案卡, when the
  human asks to freeze a contract (freeze, 冻结合同), or before any worker
  would be spawned.
---

# ship-contract

The captain talks to the human. This skill turns that conversation into a
proposal, then into a frozen contract. A proposal never dispatches a worker.

Read `templates/proposal-card.md` and `templates/contract-card.md` in the
agent-ship-kit repo and copy them. If this skill was copied out of the repo,
keep the same fields. Do not invent a second card format.

## When to use

- Intake is concrete enough to name an outcome and a check.
- The human asks for a plan, a 方案卡, or a contract.
- Something is about to be dispatched and no frozen contract covers it. Stop and do this skill first.

## When not to use

- The human is reviewing evidence. Use `ship-review`.
- A frozen contract already covers the slice and its text is not changing. Use `ship-dispatch`.
- The ask is to merge, release, or deploy. Refuse. This kit does not do those.

## Procedure

1. Restate the ask in one paragraph. If you cannot name a check that someone
   else could run, ask one question and stop. Do not paper over it with a vague
   acceptance line.
2. Copy `templates/proposal-card.md` to `.agent-ship/proposals/<proposal_id>.md`.
   Status stays `draft`. Fill every section. Put merge and production deploy
   in the out-of-scope list even if the human did not mention them.
3. Show the card in the captain thread. List open questions. Do not spawn a
   worker while any question would change acceptance, scope, or `max_parallel`.
4. Revise the draft in place while it is still a proposal. Say what changed.
5. Freeze only on an explicit human decision that names this proposal:
   "freeze", "冻结合同", or a sentence that accepts this exact text.
   These do not freeze a contract: silence, "looks good" with no proposal id,
   the captain deciding for itself, a worker, or another agent.
6. On freeze, copy the accepted text into
   `.agent-ship/contracts/<contract_id>.md` using `templates/contract-card.md`.
   Set status to `frozen`, record who froze it and when, and set
   `max_parallel` (the template default is 3; use a lower number if the human
   asked; never pick a higher one yourself).
7. Split the work into slices. One slice is one worker. Each slice lists the
   inputs that worker may see and the acceptance lines it owns.
8. Leave the dispatch log empty. `ship-dispatch` appends to it.
9. Tell the human the contract id and that workers have not been started.

## Immutability

Do not edit a file whose status is `frozen`. Write a new contract id, set
`Supersedes` to the old id, and wait for a new freeze. In-flight slices keep
the old contract until the human says to stop them.

## Worker boundary, written into the contract

The worker prompt is the slice plus its acceptance lines. It does not include
the captain transcript, secrets, or any instruction to merge or deploy.

## Handoff

When the human asks to start work, hand off to `ship-dispatch` with the
contract path. Do not dispatch inside this skill.
