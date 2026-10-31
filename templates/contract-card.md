# Contract card

Status: frozen
Contract id: `<contract_id>`
Supersedes: `<previous contract id, or none>`
Proposal id: `<proposal_id>`
Frozen by: `<human>`
Frozen at: `<ISO-8601>`

A frozen contract is immutable. To change it, write a new contract id and
point `Supersedes` at this one. Dispatch reads only status `frozen`.

## Goal

`<one paragraph copied from the accepted proposal, edited only by the human>`

## Non-goals

- `<explicitly not in this contract>`
- Merge to main
- Production deploy
- Any worker beyond the slices below

## Acceptance

- [ ] `<check>` — evidence: `<url, command, or path the packet must include>`
- [ ] `<check>` — evidence: `<url, command, or path>`

## Slices

One worker per slice. No standing roster. `max_parallel` is a ceiling the
captain may not raise.

max_parallel: 3

| Slice id | Inputs the worker may see | Done when |
| --- | --- | --- |
| `<slice_id>` | `<contract path and the inputs listed here, not the captain chat>` | `<acceptance lines this slice covers>` |

## Worker boundaries

- The worker prompt is this slice plus the acceptance lines it owns.
- The worker does not get the captain conversation, secrets, or permission to merge or deploy.
- The worker returns a review packet. It does not notify the human directly.

## Dispatch log

Append-only. The captain fills this after each adapter `spawn`.

| Slice id | Task id | Worker ref | Dispatched at |
| --- | --- | --- | --- |
|  |  |  |  |
