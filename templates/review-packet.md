# Review packet

Contract id: `<contract_id>`
Slice id: `<slice_id>`
Task id: `<source_task_id>`
Worker ref: `<worker_ref>`
Packet path: `.agent-ship/packets/<source_task_id>.md`

The captain writes this from evidence the worker returned. The worker does
not decide. The human decides. This packet does not merge and does not deploy.

## Summary

`<what changed, in a few sentences a reviewer can check>`

## Evidence

Every claim above needs a row. If a row is missing, the packet is not ready
for `priority: high`.

| Claim | Kind | Pointer | Result |
| --- | --- | --- | --- |
| `<acceptance line>` | `<test / diff / log / screenshot>` | `<evidence url or repo path>` | `<pass / fail / not run>` |

Commands that were run, with exit codes:

```text
<command>
exit <code>
```

Not run, and why:

- `<check>` — `<reason>`

## Links

- PR: `<url or none>`
- Issue: `<url or none>`
- Branch: `<name>`

## Risks left open

- `<risk the human should see before accepting>`

## Decision requested

The captain asks for one of: `accept`, `changes_requested`, `reject`.

The human's decision:

- Decision:
- Notes:

Accepting a packet means the evidence matches the frozen contract. It does
not merge the branch and it does not deploy.

## Inbox event

File this as `type: needs_review` (see `events/schema.json`):

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
