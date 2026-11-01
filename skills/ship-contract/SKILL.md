---
name: ship-contract
description: >-
  Slash command /ship-contract. The skill name is ship-contract, matching
  that command, so hosts that support skills load this file when the human
  types /ship-contract. Turn intake into a proposal card and, only after an
  explicit human freeze, into an immutable contract card. Also use when
  drafting a 方案卡, when the human says freeze or 冻结合同, or before any
  worker would be spawned.
---

# ship-contract

The captain talks to the human. This skill turns that conversation into a
proposal, then into a frozen contract. A proposal never dispatches a worker.

Read `proposal-card.md` and `contract-card.md` from the installed kit at
`$HOME/.agent-ship-kit/current/templates/` and copy them into the project. A
manual clone keeps the same files under `templates/`. Do not invent a second
card format.

## When to use

- Intake is concrete enough to name an outcome and a check.
- The human asks for a plan, a 方案卡, or a contract.
- Something is about to be dispatched and no frozen contract covers it. Stop and do this skill first.

## When not to use

- The human is reviewing evidence. Use `ship-inbox`.
- A frozen contract already covers the slice and its text is not changing. Use `ship-dispatch`.
- The ask is to merge, release, or deploy. Refuse. This kit does not do those.

## Discussion mode

While the card is `draft`, talk freely. Do not treat the conversation as a
freeze, and do not spawn a worker.

- Keep exactly one current proposal. Alternatives go in "Other options" on
  that card. If an older draft exists, set it to `superseded` and stop
  showing it as a choice.
- After every human turn that changes scope, acceptance, allowed paths,
  forbidden paths, or slices, update the card in place and add a line under
  "What changed 本轮变更" saying what moved since the previous draft.
- Show that one card (or the delta plus the file path). Do not lay two
  proposals side by side and ask the human to pick a file.
- If acceptance or either path list is still vague, ask one question and
  wait. Do not paper over it.

## 规范与经验准备

形成方案前，用 `agent-ship team context --tag <task-topic> [--project <project-id>]`
获取引用，读取适用的团队手册和项目规则。只加载与需求匹配的已验证经验摘要；
没有匹配时可以为零，必读规则不能因为经验预算而省略。
将适用规则和经验编号作为切片输入；不复制全部历史，不附上船长对话。
项目规则发生冲突时先明确归属，不用本次合同悄悄覆盖长期规范。

## Procedure

1. Copy `$HOME/.agent-ship-kit/current/templates/proposal-card.md` to `.agent-ship/proposals/<proposal_id>.md`
   on the first drafting turn. Status stays `draft`. Fill Allowed paths and
   Forbidden paths. Put merge and production deploy in the out-of-scope list
   even if the human did not mention them.
2. Stay in discussion mode until the human freezes.
3. Freeze only on an explicit human decision that names this proposal:
   "freeze", "冻结合同", or a sentence that accepts this exact text.
   These do not freeze a contract: silence, "looks good" with no proposal id,
   the captain deciding for itself, a worker, or another agent.
4. On freeze, copy the accepted text into
   `.agent-ship/contracts/<contract_id>.md` using `$HOME/.agent-ship-kit/current/templates/contract-card.md`.
   Set status to `frozen`, record who froze it and when, and copy Allowed
   paths and Forbidden paths. Set `max_parallel` (the template default is 3;
   use a lower number if the human asked; never pick a higher one, and never
   higher than the global cap in `templates/workflow.md`).
5. Split the work into slices. One slice is one worker. Each slice lists the
   inputs that worker may see and the acceptance lines it owns.
6. Leave the dispatch log empty. `ship-dispatch` appends to it.
7. Tell the human the contract id and that workers have not been started.

## Changing a frozen contract

Do not edit a file whose status is `frozen`.

1. Stop the slices the change affects. Leave finished slices that the new text does not touch; their branches and packets stay.
2. Draft a new contract id. Set `Supersedes` to the old id. Do not spawn from the draft.
3. The owner re-freezes the new contract. Until that freeze, the old contract still covers slices you did not stop.
4. Dispatch only the stopped slices, against the new id, and only after the new freeze.

## Worker boundary, written into the contract

The worker prompt is the slice, the acceptance lines it owns, and the Allowed
paths and Forbidden paths copied verbatim, plus applicable standing rules and bounded verified lesson summaries. It does not include the captain
transcript, secrets, or any instruction to merge or deploy. Empty path lists
are not ready to freeze.

## Handoff

When the human asks to start work, hand off to `ship-dispatch` with the
contract path. Do not dispatch inside this skill.
