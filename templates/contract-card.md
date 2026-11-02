# Contract card 合同卡

Status: draft
Lane: `<lane_id; default for legacy single lane>`
Owner: `<temporary owner ref>`
Contract id: `<contract_id>`
Supersedes: `<previous contract id, or none>`
Proposal id: `<proposal_id>`
Accepted text: `<exact plan text the human accepted>`
Accepted by: `<human>`
Accepted at: `<ISO-8601>`
Frozen by: `<human>`
Frozen at: `<ISO-8601>`

冻结合同不可就地修改。要改就新开合同号，并在 Supersedes 指向这一份。
只有 status 为 `frozen` 才能派工。启用 authority 后，由宿主绑定的已登记人类通道调用 `contract freeze` 写入批准回执，不能由 owner 自填人名。

## Goal 目标

`<one paragraph copied from the accepted proposal 来自已接受方案的一段话，只按人的修改来写>`

## Non-goals 非目标

- `<explicitly not in this contract 明确不在本合同里的事>`
- 合并到 main
- 生产部署
- 下面切片之外的工人

## Acceptance 验收

验收可以列出 `feature:<id>`。id 来自 `.agent-ship/e2e/index.md` 的 Features 表。每个 id 单独取证，指针是报告，不是 storageState。

- [ ] `<check 检查>` — evidence 证据: `<url, command, or path>`
- [ ] `<check>` — evidence 证据: `<url, command, or path>`
- [ ] `feature:<id>` — evidence 证据: `<Playwright report path or CI URL>`

## Human review budget 人工审阅预算

从已接受的方案原样抄来，次数、审阅条目和可选备注都要一致。验收时用 `human_reviews_expected` 对照 `agent-ship check` 报告的 `inbox_needs_review_count`（该合同的 `needs_review` 条数，含已决定的）。对不上由人判断。本工具不自动合并，也不代人点合并。

human_reviews_expected: `<count>`

- `<这次审阅看什么，例如 方案冻结>`
- `<例如 验收>`
- `<例如 合 PR>`

must_human: `<仍要人做的事；不需要就删掉这一行>`

already_automated: `<硬检查已经覆盖的事；不需要就删掉这一行>`

## Allowed paths 允许改动的路径

工人提示词必须原样带上这一节。不在列表里的路径不能改。

- `<path or glob>`

## Forbidden paths 禁止改动的路径

- `<path>`
- `.env`、密钥、生产配置
- 未点名的 lockfile

## Slices 切片

一个切片一个工人。没有常驻花名册。
`max_parallel` 是本合同的上限，船长不能自行提高。
跨所有合同同时处于 queued/running 的工人还有一个全局上限，默认 3。见 `templates/workflow.md`。本合同的 `max_parallel` 不能高于全局上限。

max_parallel: 3

| Slice id | role | Inputs the worker may see 工人能看到的输入 | Done when 完成标准 |
| --- | --- | --- | --- |
| `<slice_id>` | generic-worker | 本合同路径、本切片、允许/禁止路径。不要附上船长对话。 | `<acceptance lines this slice covers>` |

## Standing context 长期上下文

- 团队手册与项目规则引用（使用方已有来源优先）:
- 本切片适用的经验标签与可选项目标识:
- 采用的 active 经验编号（可为零；以派工记录为准）:

工人读取适用规范，只加载相关经验摘要，按需展开原文。这里不复制全部历史或船长对话。

## Worker boundaries 工人边界

- 工人提示词 = 本切片 + 它负责的验收项 + 允许路径 + 禁止路径。
- 工人拿不到船长对话、密钥，也没有合并或部署的许可。
- 工人把证据交回本 lane 的 owner，由独立 verifier 核验。卡住或需要中途拍板时，owner 写入 inbox（`blocked` / `needs_approval`）。人不要去打开工人会话。
- 工人不直接通知人。

## Dispatch log 派工记录

派工和状态写入 `.agent-ship/events.jsonl`，不追加到已冻结的文件（整个合同内容受批准摘要保护）。下表只在草稿阶段填写规划；实时记录看事件流。

| Slice id | Task id | Worker ref | Status | Dispatched at |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
