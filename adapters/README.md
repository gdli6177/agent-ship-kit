# Adapters

agent-ship-kit does not orchestrate workers. It describes three calls a
captain may make, and leaves the transport to a thin note. Swapping Herdr for
Orca, Multica, or a plain extra agent session must not change the contract
card, the inbox event, or the notify allowlist.

## Files

| File | Role |
| --- | --- |
| [generic.md](generic.md) | Normative `spawn` / `status` / `collect` contract. Read this first. |
| [herdr.md](herdr.md) | What to map those calls onto when the human already uses Herdr. |
| [orca.md](orca.md) | Same for Orca. |
| [multica.md](multica.md) | Same for Multica, plus how the `multica` notify pattern differs from dispatch. |

## How to plug one in

1. Keep the human in one captain thread (`docs/PRODUCT.md`).
2. Dispatch only from a frozen contract (`skills/ship-dispatch/SKILL.md`).
3. Implement the three calls in `generic.md` against that product's documented
   task API. Write the translation next to the product note if the names differ.
4. Return evidence to the captain. The captain files `needs_review`.
5. Leave merge and production deploy on the human's side of the product. Do
   not add them to the adapter to "complete the loop".

## No orchestrator

Follow the "No orchestrator" section of `generic.md`. The quickstart in the
README runs the inbox and a notify dry-run with no Multica binary and no
Herdr or Orca account.

v0 ships notes, not SDK bindings. A binding belongs in a later change only if
it still refuses to merge and deploy.
