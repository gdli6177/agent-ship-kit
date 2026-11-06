# Adapters

> **Legacy (0.2-era):** these adapter notes describe the retired manual-contract
> captain workflow. Crewvane 0.6 does not orchestrate workers through this
> interface; see `docs/crewvane.md` and `skills/crewvane/` for the current flow.
> The files are kept for historical reference.

crewvane does not orchestrate workers. It describes three calls a
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
6. Subscribe each slice's `thread_refs` (PR, issue, chat). Deliver follow-up
   events on those threads to the owning worker. Send the captain only new
   or unowned events, and anything that crosses slices.
7. Run `crewvane watchdog` on a schedule: cron, the orchestrator's
   scheduler, or the owner's assistant routine. Append `worker_progress`
   heartbeats to `.crewvane/events.jsonl` when the worker makes real
   progress. The watchdog is not the captain.

## Not this kit

Persistent cloud runtimes, splitting compute from state, and device daemons
belong to the orchestrator. An adapter maps `spawn`, `status`, `collect`,
thread delivery, and a watchdog schedule onto that product. It does not
reimplement them inside crewvane.

## No orchestrator

Follow the "No orchestrator" section of `generic.md`. The quickstart in the
README runs the inbox and a notify dry-run with no Multica binary and no
Herdr or Orca account.

v0 ships notes, not SDK bindings. A binding belongs in a later change only if
it still refuses to merge and deploy.

## 团队上下文与收尾

spawn 前将 slice start 返回的 context 引用与有限经验摘要交给对应工人。
真实进展和状态用 slice update 回传，保留共享状态中的顺序。
独立核验者先核验代码，再返回经验影响；船长记录 lesson check 后才添加待审项。
取消/失败可以立即停止，船长随后检查 lesson pending。适配器不接管规范或知识源所有权。
