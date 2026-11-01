---
name: ship-dispatch
description: >-
  Slash command /ship-dispatch. The skill name is ship-dispatch, matching
  that command, so hosts that support skills load this file when the human
  types /ship-dispatch. Spawn on-demand workers for a frozen contract under
  the global cap and max_parallel, and record the slice with agent-ship
  slice start. Also use for 开始、继续、做到哪了 in a captain conversation
  with an identified frozen contract, when a worker is blocked
  or needs approval, or when mapping spawn onto Herdr, Orca, Multica, or a
  plain extra agent session.
---

# ship-dispatch

The captain is a router, not an executor. Dispatch is a gate in front of
whatever orchestrator the human already uses. This skill does not schedule a
fleet, does not keep a worker roster, and does not merge or deploy. Templates
and adapters live in the kit at `$HOME/.agent-ship-kit/current/`.

## Router

The captain talks to the owner, drafts contracts, dispatches slices, routes
events, and records decisions. It does not edit product code and it does not
run the long task itself, including work that looks small. Prompt-only
delegation is unreliable: the same context that holds the plan will start
implementing. The frozen contract is the handoff.

Do not block waiting on a worker. Accept the owner's next request while
slices run. Ask the adapter for status when you need it; do not sit in the
worker session.

Carry the contract/task references across skills yourself. A clear “按这个
方案开始” after proposal review authorizes freezing plus dispatch; do not
require `/ship-dispatch` or an id repeated by the human. For “做到哪了 / how is
it going”, inspect real adapter status and inbox and return a short summary
of running work, pending decisions and results. Status questions do not
authorize new workers, replacement tasks or resumption of paused work.

For “先停下 / stop for now”, resolve the task from context (ask only if
ambiguous), use the execution mechanism to stop it, and record the actual
result with `slice update`. Recording `cancelled` alone does not terminate a
process. If the adapter cannot stop it, say so immediately; do not claim it
stopped. Stop does not authorize a replacement worker.

Handle in-scope technical questions and verifier corrections within the
existing task. Interrupt the human only for missing user intent, scope changes,
unavailable permissions/capabilities or a decision they must own. Do not pass
internal logs or routine learning checks to them. Respect existing approvals;
“continue” cannot silently expand scope or replace a failed worker.

## Thread subscription

Every dispatched slice records `contract_id`, `slice_id`, and `thread_refs`
(PR URL, issue, chat thread) on its `worker_dispatched` event in
`.agent-ship/events.jsonl`. Follow-up events on a subscribed thread — PR
review comments, CI results, chat replies — go straight to the owning worker.
The captain handles only new or unowned events, and coordination that crosses
slices. Append a `worker_progress` heartbeat when the worker reports real
progress; that is what `/ship-watchdog` reads.

The adapter contract is `adapters/generic.md`. If the human named Herdr, Orca,
or Multica, also read the short note under `adapters/` for that system. The
kit calls stay `spawn`, `status`, and `collect`.

## Preconditions (all required)

- A contract file exists and its status is exactly `frozen`.
- The human froze it (see `ship-contract`). A draft proposal is not enough.
- The slice id is a row in that contract.
- That slice has no `running` task, unless the human explicitly asked to
  replace a `failed` or `cancelled` one.
- The contract has non-empty Allowed paths and Forbidden paths.
- Spawning it would not exceed this contract's `max_parallel`.
- Spawning it would not exceed the global cap (default 3 across every
  contract). See `templates/workflow.md`.

If any line fails, do not spawn. Tell the human which line failed.

## Parallel caps

- Global cap: use the shared CLI event/inbox running view for every contract under
  `.agent-ship/contracts/` whose status is `queued` or `running`. The ceiling
  is `global_max_parallel` in `.agent-ship/limits.json` when the human put a
  positive integer there, otherwise 3. Do not raise it yourself.
- Contract cap: read `max_parallel` from this contract. If the field is
  missing, use 3 and say so. If it is higher than the global cap, treat the
  global cap as the real ceiling and say so.
- A new worker has to fit under both remainders. If either count is already
  at its cap, leave the slice unspawned. Do not queue it inside an
  orchestrator the human did not ask you to use.
- There is no pre-built roster. Not spawning idle workers is the normal case.

## 规范与经验上下文

使用 `team context --repo <checkout> --tag <topic> [--project <id>]` 读取必读引用和
匹配的 active 摘要。同样的标签和项目标识传给 `slice start`，将返回的 context
交给工人：读取 required_sources，使用匹配经验，必要时只展开一条 `lesson show`。
派工事件记录所用来源和经验编号。不要把候选、失效经验或整段历史当作执行规范。
匹配的旧经验需要复核时先检查其适用条件；团队规则和项目原有权限继续有效。

## Spawn

For multiple repositories/worktrees, read `docs/workspace-parallel.md`.
Use one shared state `--root` for contracts, budgets and inbox, and a distinct
`--repo` for each execution checkout. Allowed/Forbidden paths are relative to
the execution repository. Never let parallel workers share a checkout or index.

1. Build the worker prompt from its frozen slice, acceptance lines, Allowed
   paths, Forbidden paths, repository and branch, plus applicable team/project rules and selected verified lessons. Do not attach captain chat,
   secrets, merge instructions or production deployment permission.
2. Prepare the isolated checkout and branch using the orchestrator's supported
   facilities. Choose a stable kit task id before starting a model process.
3. Reserve the task with `slice start`. This atomically checks the frozen
   contract, slice membership, duplicate work and both parallel caps. The
   branch must exist. If admission fails, do not spawn anything.

Run this in the project directory. Use `agent-ship` on `PATH`. If that command is not found, use `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js` with the same arguments.

```bash
agent-ship slice start --root <shared_state_root> \
  --repo <execution_checkout> --contract <contract_id> --slice <slice_id> \
  --source-task-id <stable_kit_task_id> --title "<slice>" --summary "<one line>" \
  --branch ship/<contract_id>/<slice_id> --base <base_ref>
```

4. Write the contract id to the execution checkout's
   `.agent-ship/active-contract`. Install that checkout with `setup --root
   <checkout> --state-root <shared_state_root>` so its hook reads the shared
   contract and checks its own index.
5. Call adapter spawn with the contract path, slice id, stable kit task id and
   prompt. Map the kit id to the platform run id. Record its reference with
   `slice update --root <shared_state_root> --source-task-id <id> --status
   running --worker <platform_ref>`. Do not admit the slice a second time.
6. If spawn fails, update the reservation to `failed`. Replace failed/cancelled
   work only with human authorization, a new task id and `slice start --replace`.
7. Append the human-readable dispatch log. The CLI event/inbox view is the
   authoritative count for admission; the Markdown log is an audit view.

The worker returns evidence or escalations to the captain. It does not notify
the human. Notification is `ship-notify`, after the captain files an inbox item.

## While work is in flight

Use `slice update --root <shared-root> --source-task-id <id> --status <status>`
for real progress, failed/cancelled states and explicit resumption. Inbox
needs_review/blocked/needs_approval items pause the running state automatically.
Record the human decision before resuming; resumption rechecks both caps.

- Poll adapter `status` when the human asks, or when you are about to file a
  review. Do not busy-loop.
- Map foreign states onto `queued`, `running`, `needs_review`, `blocked`,
  `needs_approval`, `failed`, or `cancelled` (see `templates/workflow.md`).
  Append a dispatch-log row when the status changes. The latest row for a
  task id is the one that counts.
- On `failed` or `cancelled`, report the adapter's reason. Do not spawn a
  replacement unless the human asks.
- `status` and `collect` never include a merge or a production deploy. If the
  orchestrator offers those operations, do not call them.

## Escalation

The owner never opens a worker session. If the worker is stuck or needs a
mid-task decision, it returns a short note to the captain through `collect`
(or the session result). The captain then:

1. Tells the owner in the captain thread, in a few sentences, what is blocked
   and which contract paths are involved.
2. Files the inbox item:

```bash
agent-ship inbox add \
  --type blocked \
  --title "<one line>" \
  --summary "<what the owner must decide>" \
  --source-task-id "<task id>" \
  --path ".agent-ship/contracts/<contract_id>.md"
```

Use `--type needs_approval` when the worker can continue after a yes or no
(for example a path that is not on the allow list). Use `blocked` when it
cannot continue at all (captcha, missing test account, failing login).

3. Waits for `inbox decide <id> accept|changes_requested|reject`. Relays that
   decision back to the same worker. Does not spawn a replacement unless the
   decision says to and both parallel caps still allow it.

Do not hand the owner a worker transcript to read.

## No-orchestrator path

When the human is not using Herdr, Orca, or Multica, `spawn` means one fresh
agent session whose only task context is the slice. You are still the only
agent in the human's thread. Do not pretend that session is a standing worker.

## 失败、退回与收尾检查

用户纠正、核验退回、同类问题复发或发现重要约束时，在当前任务记录短线索和证据。
根因尚未证实时不要新增活动经验。只读核验者在完成独立代码核验之后，返回
none/candidate、原因、证据和适用性；船长负责记录候选与 lesson check。
failed/cancelled 必须能立即停工，随后用 `lesson pending` 查收尾遗漏，补经验检查。
同一个坑再次发生时，结合已加载的经验编号检查检索、表达、执行和门禁，不直接再新增一条。

## Handoff

When the worker reports done, do not file the inbox and do not call `/ship-inbox` yet.

1. Spawn a separate read-only verifier. Its only prompt is `templates/verifier-prompt.md` plus the frozen contract path and the branch name. Do not attach the worker chat.
2. The verifier re-runs the acceptance commands, `agent-ship check --contract <id>`, and any E2E smoke the contract requires.
3. If the verifier disagrees, send that result back to the same worker. Do not tell the owner.
4. After the verifier agrees on code and returns the learning assessment, the verifier records `lesson check` (none/candidate, reason, reviewed-by a verifier reference that is not the worker; candidate ids when needed). `none` is the normal audit line when there is nothing new to keep. Do not ask the human to perform or confirm that check. The CLI validates this round before needs_review when `learning_required` is true. Then fill the packet's Verifier section and hand off to `ship-inbox`, which files `needs_review`. The notify text includes `/ship-inbox <id>`.

When `learning_required` is true, `slice start` requires `--worker`. The CLI also refuses the start unless the contract records Accepted text (the exact plan), Accepted by, Accepted at, and Proposal id, and refuses a proposal id that does not match `--proposal` or the proposal card.
