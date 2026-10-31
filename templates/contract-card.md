# Contract card 合同卡

Status: frozen
Contract id: `<contract_id>`
Supersedes: `<previous contract id, or none>`
Proposal id: `<proposal_id>`
Frozen by: `<human>`
Frozen at: `<ISO-8601>`

冻结合同不可就地修改。要改就新开合同号，并在 Supersedes 指向这一份。
只有 status 为 `frozen` 才能派工。

## Goal 目标

`<one paragraph copied from the accepted proposal 来自已接受方案的一段话，只按人的修改来写>`

## Non-goals 非目标

- `<explicitly not in this contract 明确不在本合同里的事>`
- 合并到 main
- 生产部署
- 下面切片之外的工人

## Acceptance 验收

- [ ] `<check 检查>` — evidence 证据: `<url, command, or path>`
- [ ] `<check>` — evidence 证据: `<url, command, or path>`

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

| Slice id | Inputs the worker may see 工人能看到的输入 | Done when 完成标准 |
| --- | --- | --- |
| `<slice_id>` | 本合同路径、本切片、允许/禁止路径。不要附上船长对话。 | `<acceptance lines this slice covers>` |

## Worker boundaries 工人边界

- 工人提示词 = 本切片 + 它负责的验收项 + 允许路径 + 禁止路径。
- 工人拿不到船长对话、密钥，也没有合并或部署的许可。
- 工人把证据交回船长。卡住或需要中途拍板时，也只回给船长，由船长写入 inbox（`blocked` / `needs_approval`）。人不要去打开工人会话。
- 工人不直接通知人。

## Dispatch log 派工记录

只追加，不改冻结条款。状态变化时追加一行，同一 task id 以最后一行为准。

| Slice id | Task id | Worker ref | Status | Dispatched at |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
