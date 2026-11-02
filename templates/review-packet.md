# Review packet 待审证据包

Contract id: `<contract_id>`
Slice id: `<slice_id>`
Task id: `<source_task_id>`
Worker ref: `<worker_ref>`
Packet path: `.agent-ship/packets/<source_task_id>.md`

船长根据工人交回的证据填写。工人不做决定，人做决定。这份包不合并、不部署。

## Recall 回溯

`/ship-inbox` 先只看这张卡片。下面的章节等主人要求再展开。

Inline summary 摘要（最多 280 字）:

`<one short paragraph>`

Next hop 下一跳: contract `<contract_id>` → slice `<slice_id>` → worker `<worker_ref>` / branch `<branch>` → PR `<url>` → evidence `<url>`

## Summary 摘要

用几句人能对照 diff 核对的话写清改了什么。

`<what changed>`

## Evidence 证据

上面每条主张都要有一行。没有指针的行，不能把优先级标成 `high`。
合同里的每个 `feature:<id>` 单独一行。不要把 storageState、cookie 或密码贴进这张表。

| Claim 主张 | Kind 类型 | Pointer 指针 | Result 结果 |
| --- | --- | --- | --- |
| `<acceptance line 验收项>` | `<test / diff / log / screenshot>` | `<evidence url or repo path>` | `<pass / fail / not run>` |
| `feature:<id>` | e2e | `<report path or URL，不要写 storageState>` | `<pass / fail / not run>` |
| `feature:<another-id>` | e2e | `<report path or URL，不要写 storageState>` | `<pass / fail / not run>` |

Commands that were run, with exit codes:

```text
<command>
exit <code>
```

Not run, and why:

- `<check>` — `<reason>`

## Links 链接

- PR: `<url or none>`
- Issue: `<url or none>`
- Branch 分支: `<name>`

## Verifier 独立核验

独立的只读核验，没有看过工人对话。不同意就不进收件箱，退回工人，不要打扰人。

- Verifier ref:
- `agent-ship check`: `<ok true/false，violations 摘要>`
- Acceptance commands rerun 重跑的验收命令:
- E2E feature rerun 重跑的功能冒烟: `feature:<id>` → `<report path or URL，不要写 storageState>`
- Agrees with the worker 与工人一致: yes / no

## Learning check 经验检查

- Outcome: none / candidate
- Reason:
- Verifier ref:
- 本轮适用的团队/项目规则与经验编号:
- 候选编号、来源与查重结论（none 时留空，不创建文件）:

这里只放本轮短结论，完整证据保留指针。CLI 回执记录在运行事件中，不复制整个经验库。

## Risks left open 仍开放的风险

接受之前人应该看到的风险。

- `<risk>`

## Decision requested 请人决定

船长只能请求 `accept`、`changes_requested` 或 `reject`。决定由人来填，或用 `inbox decide`。

- Decision 决定:
- Notes 备注:

Accepting a packet means the evidence matches the frozen contract. It does
not merge the branch and it does not deploy.

## Inbox event 收件箱

做完的切片用 `inbox add`（默认 `needs_review`）。中途卡住用 `--type blocked`，中途要拍板用 `--type needs_approval`。人不要去打开工人会话。决定用 `inbox decide <id> accept|changes_requested|reject`。`inbox list` 默认只显示还没决定的项。

`priority: high` 且没有证据 URL 时，通知不会呼叫。

File a finished slice as `type: needs_review` (see `events/schema.json`):

```json
{
  "id": "evt_<id>",
  "type": "needs_review",
  "title": "<slice> is ready for review",
  "summary": "<same summary as above, one paragraph>",
  "evidence_urls": ["<pointer>"],
  "priority": "normal",
  "created_at": "<ISO-8601>",
  "source_task_id": "<task id>",
  "links": {
    "pr": "<url>",
    "issue": "<url>",
    "path": ".agent-ship/packets/<source_task_id>.md"
  },
  "contract_id": "<contract_id>",
  "slice_id": "<slice_id>"
}
```

Use `priority: high` only when the contract deadline or the human's earlier
instruction says this review should interrupt them, and only when at least
one evidence URL is present.
