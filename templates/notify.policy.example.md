# Notify policy (example)

## Instructions

The parser ignores this section. The captain reads it and may turn it into an
argv with `notify dry-run --action` or `notify run --action`. The allowlist
is still enforced. A free-text plan does not bypass it, and it does not bypass
the empty-evidence refusal below.

Pull is the default. A normal `needs_review` stays in the inbox. Do not plan
a push for it. The owner looks at `inbox list`.

Push only when all of the following are true for the chosen rule:

- the event is `needs_review` with `priority: high` and a non-empty `evidence_urls`, or
- the event is `blocked`, or
- the event is `needs_approval`

High-priority `needs_review` with an empty `evidence_urls` must not page, even
if a rule or `--action` names a command. `blocked` and `needs_approval` may
push without evidence, because the owner is stuck mid-task and does not open
the worker session.

Do not put tokens, signing keys, or webhook secrets in this file. Do not add
a shell pipeline. Merging and production deploy are out of scope even when
`allow` is true.

`notify dry-run` only prints the plan. `notify run` is opt-in: it starts the
allowlisted argv with no shell, and only when `allow` is true.

This Instructions section is the slow path. The `## Rule:` blocks below are
the fast path. A push stays under 100 words, asks for a decision, and names
`/ship-inbox <id>`. Speculative drafts are off unless
`.agent-ship/limits.json` sets `"speculative": true`. Even then the captain
does not dispatch or edit code without a frozen contract, and it only shows
the owner a draft that already has evidence.

## Rule: high priority page

when.priority: high
when.type: needs_review
when.evidence_urls: nonempty
action: curl -X POST https://hooks.example/ship /ship-inbox {id}
note: Page only when evidence exists. Deep link /ship-inbox {id}. Do not merge or deploy.

## Rule: blocked

when.type: blocked
action: multica issue create --assignee me --title blocked /ship-inbox {id}
note: Mid-task block. Open /ship-inbox {id}. The owner does not open the worker session.

## Rule: needs approval

when.type: needs_approval
action: multica issue create --assignee me --title needs-approval /ship-inbox {id}
note: Mid-task approval. Open /ship-inbox {id}. The owner does not open the worker session.

## Never

- Do not add a push rule for normal `needs_review`.
- Do not treat a dry-run as permission to run a command the plan did not allow.
- Do not widen the allowlist to `multica *`, `*`, a shell, or `sudo`.
