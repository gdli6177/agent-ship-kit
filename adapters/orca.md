# Orca

v0 does not ship an Orca client. When the human is already running Orca, keep
the captain on `generic.md` and translate the three calls onto Orca's own
workflow or task API:

| Kit call | On the Orca side |
| --- | --- |
| `spawn` | Start one task whose input is the frozen slice, not the captain chat. |
| `status` | Read that task and report `queued`, `running`, `needs_review`, `failed`, or `cancelled`. |
| `collect` | Return the summary, evidence URLs, and links the task actually produced. |

Use Orca's documented create and status operations. Do not invent endpoint
paths in the captain thread. Do not call an Orca operation that merges or
deploys. If a name in Orca's API does not match this table, keep the
translation next to this note and leave the kit calls unchanged.
