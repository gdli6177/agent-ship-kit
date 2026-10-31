# Proposal card 方案卡

Status: draft
Proposal id: `<proposal_id>`
Opened: `<YYYY-MM-DD>`

这不是合同。工人不会从这张卡开工。船长维护它；人冻结，或者退回。
This card is not a contract. Workers are not spawned from it.

讨论模式：同一时间只摆这一张当前方案。每轮改完，更新下面的「本轮变更」。
Discussion mode: one current proposal. After each round, fill "What changed".

## Ask 需求

用一两段话写清谁要什么、为什么是现在。

`<one paragraph: who needs what, and why now>`

## Acceptance sketch 验收草案

每一条都要能拿证据核对，不能只靠工人的判断。

- [ ] `<observable outcome 可观察的结果>`
- [ ] `<check, command, or artifact 用来证明的检查、命令或产物>`

## Allowed paths 允许改动的路径

工人只能改这些路径。写仓库内的相对路径或 glob。

- `<path or glob>`

## Forbidden paths 禁止改动的路径

这些路径默认禁止，除非你在允许列表里点名。

- `<path>`
- `.env`、密钥、生产配置
- 未在本方案里点名的 lockfile

## Recommended slice 建议切片

`<the smallest change that satisfies the acceptance sketch>`

本方案明确不做：

- `<nearby work that is not this slice>`
- 合并到 main
- 生产部署

## Other options 其他方案

备选写在这张卡里，不要另外再开一张「当前方案」。

| Option 方案 | Why it lost 为什么没选 |
| --- | --- |
| `<alternative>` | `<reason>` |

## Risks 风险

- `<risk 风险，以及什么证据能发现它>`

## Open questions 待确认

冻结前必须由人回答的问题。

- `<question>`

## What changed 本轮变更

相对上一稿改了什么。第一稿写「初稿」。

- `<delta>`

## Freeze 冻结

人明确说 freeze / 冻结合同之前，这一节留空。

- Frozen by 冻结人:
- Frozen at 冻结时间:
- Contract id 合同号:
