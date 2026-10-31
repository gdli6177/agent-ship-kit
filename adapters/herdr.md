# Herdr

v0 does not ship a Herdr client. When the human is already running Herdr, keep
the captain on `generic.md` and translate the three calls onto Herdr's own
task or agent-run API:

| Kit call | On the Herdr side |
| --- | --- |
| `spawn` | Create one run whose prompt is the frozen slice, not the captain chat. |
| `status` | Read that run and report `queued`, `running`, `needs_review`, `blocked`, `needs_approval`, `failed`, or `cancelled`. |
| `collect` | Return the summary, evidence URLs, and links the run actually produced. |

Use Herdr's documented create and status operations. Do not invent endpoint
paths in the captain thread. Do not call a Herdr operation that merges,
lands, or deploys. If a name in Herdr's API does not match this table, keep
the translation next to this note and leave the kit calls unchanged.
