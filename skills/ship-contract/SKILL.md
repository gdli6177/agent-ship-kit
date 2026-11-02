---
name: ship-contract
description: >-
  Handle new feature, fix or change requests in an agent-ship-kit captain
  conversation, including 加一个功能、修一下这个问题、另开一个需求 and
  按这个方案开始、继续、接管、收口、上测试、上线、你来做、这个你处理. Draft a proposal, then freeze only after explicit human
  acceptance of its exact scope. Also supports /ship-contract and freeze.
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

## Intake and guard

收到执行类请求先运行 `agent-ship intake --text "<原文>"`，复用明确需求的 id。
只读调查可以完善方案；不得改产品、运行长测试、触发 CI 或派工。优先在本轮
展示范围与验收，不把调查无限延伸成执行。恢复时先 doctor，不借用旧需求授权。

无匹配冻结合同时回复：已登记为 `<proposal_id>`，下面是范围与验收，确认后派工。
执行前运行 guard；失败即停止修改类工具。CLI 和 Git hook 不能拦截全部工具调用，
宿主需要更强管控时须在 pre-tool 边界调用 guard。

只有人明确要求直接执行且范围完整，才可用 `intake --direct`，记录 allowed、
forbidden、accepted-by、accepted-text。不得把“继续”当作直接执行授权。

## Discussion mode

The human describes an outcome; you manage the procedure. Inspect the project
to resolve technical details yourself, suggest acceptance checks and ask only
questions that materially affect the result. Show a concise goal, scope and
acceptance summary, with details available on request. Generate and retain ids
yourself; never require the human to copy them between skills.

After presenting the current proposal, ask “按这个方案开始吗？ / Start with this
plan?” An explicit “按这个方案开始 / Start with this plan” can both freeze and
authorize dispatch when it unambiguously refers to the exact proposal just
shown. Record the resolved proposal id, accepted text, human and time before
handing off. If several proposals could be meant, scope has changed, or the
accepted version cannot be recovered, ask one focused clarification. A bare
“好的 / looks good”, silence or the original request is not a freeze.

While the card is `draft`, talk freely. Do not treat the conversation as a
freeze, and do not spawn a worker.

- Keep exactly one current proposal. Alternatives go in "Other options" on
  that card. If an older draft exists, set it to `superseded` and stop
  showing it as a choice.
- After every human turn that changes scope, acceptance, allowed paths,
  forbidden paths, slices, or the human review budget, update the card in
  place and add a line under "What changed 本轮变更" saying what moved since
  the previous draft.
- Show that one card (or the delta plus the file path). Do not lay two
  proposals side by side and ask the human to pick a file.
- If acceptance or either path list is still vague, ask one question and
  wait. Do not paper over it.

## 规范与经验准备

形成方案前，用 `agent-ship team context --auto --tag <task-topic> [--project <project-id>]`
获取引用，读取适用的团队手册和项目规则。只加载与需求匹配的已验证经验摘要；
没有匹配时可以为零，必读规则不能因为经验预算而省略。
将适用规则和经验编号作为切片输入；不复制全部历史，不附上船长对话。
项目规则发生冲突时先明确归属，不用本次合同悄悄覆盖长期规范。

## Procedure

1. Run intake first, then fill its registered proposal using `$HOME/.agent-ship-kit/current/templates/proposal-card.md`
   at `.agent-ship/proposals/<proposal_id>.md`; preserve Proposal id, Request and Created at. Status stays `draft`. Fill Allowed paths and
   Forbidden paths. Put merge and production deploy in the out-of-scope list
   even if the human did not mention them. Fill Human review budget:
   `human_reviews_expected` is how many human reviews this line still needs,
   and the list under it says what each review is for (for example 方案冻结,
   验收, 合 PR). The count must equal the list. Optional `must_human` and
   `already_automated` notes say what still needs a person and what hard
   checks already cover; delete a note you are not using. Do not leave
   placeholders. This kit does not auto-merge or click merge.
2. Stay in discussion mode until the human freezes.
3. Freeze only on an explicit human decision accepting this exact proposal:
   an id or an unambiguous reference to the just-presented text is sufficient.
   Resolve and record the id yourself. Silence, casual acknowledgement,
   the captain deciding for itself, a worker or another agent cannot freeze.
4. On freeze, copy the accepted text into
   `.agent-ship/contracts/<contract_id>.md` using `$HOME/.agent-ship-kit/current/templates/contract-card.md`.
   Set status to `frozen`. Record the exact plan in `Accepted text`, the human
   in `Accepted by`, the time in `Accepted at`, and `Proposal id`. Also record
   who froze it and when, and copy Allowed paths, Forbidden paths, and the
   Human review budget (the same count, the same purpose list, and the same
   optional notes). Acceptance compares that count with the contract's inbox
   `needs_review` count. Do not merge.
   When `learning_required` is true, `slice start` refuses empty Accepted text,
   Accepted by, Accepted at, or Proposal id, and refuses a proposal id that
   does not match the contract or `--proposal`. The CLI enforces that record.
   Set `max_parallel` (the template default is 3;
   use a lower number if the human asked; never pick a higher one, and never
   higher than the global cap in `templates/workflow.md`).
5. Split the work into slices. One slice is one worker. Each slice lists the
   inputs that worker may see and the acceptance lines it owns.
6. Leave the dispatch log empty. `ship-dispatch` appends to it.
7. If the human also authorized starting, hand off directly to `ship-dispatch`.
   If they only froze, report that it is ready without claiming work started.

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
contract path. Do not ask for a second command or repeat an already granted
start approval. A freeze-only decision does not imply dispatch authorization.

## 纠正与收尾

纠正立即用 correction add 留痕，派工前也可用。event 仅记一次性事实；lesson /
handbook 需 project 或显式 team，并填 when/action。保留历史风险，按纠正注记
修订当前方案。收尾运行 learning extract 与 learning review，记录 none/candidate。
经验仅由维护者审核激活，不自动改手册、合同范围或硬规则。
