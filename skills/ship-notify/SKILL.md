---
name: ship-notify
description: >-
  Slash command /ship-notify. The skill name is ship-notify, matching that
  command, so hosts that support skills load this file when the human types
  /ship-notify. Plan or send a notification from a markdown policy and an
  argv allowlist by calling agent-ship notify dry-run or notify run. Also
  use when a needs_review, blocked, or needs_approval event should reach the
  human, or when editing notify policy.
---

# ship-notify

Two filters, in order:

1. **Fast path.** The CLI matches `## Rule:` blocks and the allowlist. It does not call a model. Push only for a high-priority `needs_review` that has evidence, or for `blocked` / `needs_approval`. A normal review stays in the inbox (pull).
2. **Slow path.** The captain reads the prose Instructions section and may pass `--action`. The allowlist and the empty-evidence refusal still apply. The slow path does not outrank a fast-path denial.

Pull is the default. A normal `needs_review` stays in the inbox. Push only
for a high-priority `needs_review` that has evidence, or for `blocked` /
`needs_approval`.

## Channel norms

A push notification is at most 100 words, says what decision is needed, and includes `/ship-inbox <id>`. The plan reports `push_words` and `push_within_budget`. The review packet and the PR body are the long form: structured, complete, and separate from the push. Do not paste the packet into the push.

`notify dry-run` prints a plan and starts nothing. `notify run` is opt-in: it
starts the allowlisted argv with no shell, and only when the plan says
`allow: true`. Neither command expands environment variables or reads secrets.

The example policy has an Instructions section the captain reads. Structured
`## Rule:` blocks are what the CLI matches. The captain may turn the
free-text section into an argv and pass `--action`. The allowlist and the
empty-evidence refusal still apply.

Policy: `.agent-ship/notify.policy.md` after `/ship-setup`, or `$HOME/.agent-ship-kit/current/templates/notify.policy.example.md`.
Allowlist: `.agent-ship/notify.allowlist.json`, or `$HOME/.agent-ship-kit/current/templates/notify.allowlist.example.json`.
Prefer an exact subcommand such as `multica issue create --assignee me *`.
Do not widen that to `multica *`.
The parser and the match rules are normative in `docs/ARCHITECTURE.md`.

## When to use

- A `needs_review`, `blocked`, or `needs_approval` event was just written and the human might need a ping. Normal review items are pull: show `inbox list` and do not push.
- The human asks how they will be reached.
- You are about to add a channel, a webhook, or a command. Stop and change policy plus allowlist first, with the human's edit.

## Dry-run

Run this in the project directory. Use `agent-ship` on `PATH`. If that command is not found, use `"$HOME/.agent-ship-kit/current/cli/bin/agent-ship.js"` with the same arguments.

```bash
agent-ship notify dry-run --latest \
  --policy .agent-ship/notify.policy.md \
  --allowlist .agent-ship/notify.allowlist.json
```

Use `--event <file.json>` instead of `--latest` when the event is not the newest open inbox item. Add `--action 'multica issue create --assignee me --title from-captain'` only when the free-text section told you to plan an argv the rules did not already name.

`notify run` takes the same flags and, only when `allow` is true, executes that argv with no shell. Dry-run first. Do not run when `allow` is false. The example actions include `/ship-inbox {id}`, which the planner fills with the inbox id so the owner can open that one item.

Read the JSON plan:

| Field | Meaning |
| --- | --- |
| `executed` | `false` on a dry-run. On `notify run`, `true` only after the child exits 0. |
| `allow` | The action's argv matched an allowlist pattern. |
| `reason` | `allowlisted`, `not_allowlisted`, `no_matching_rule`, `missing_evidence`, `shell_metacharacter`, `shell_interpreter`, or `empty_action`. |
| `matched_rule` | First policy rule whose `when.` lines all matched. |
| `argv` | The planned argument vector, or null if the action was rejected as shell syntax. |
| `pattern` | The allowlist pattern that matched, if any. |

Show that JSON to the human. A high-priority `needs_review` with an empty `evidence_urls` is `missing_evidence` or `no_matching_rule`, and `allow` is false. Do not page it. `blocked` and `needs_approval` may still push.

## If `allow` is false

Say the reason in plain language. Do not rewrite the action into a nearby command that would pass. Do not add a temporary allowlist entry. Ask the human to edit the policy and the allowlist if a different reach-out is actually wanted. Do not call `notify run`.

## If `allow` is true

Say which rule matched and which pattern allowed it. Run only if the human wants the push, and only via `notify run` (no shell). A passing plan is not permission to merge or deploy. Normal `needs_review` items stay pull even if you can imagine a command.

## Editing policy

- Rules are `## Rule: <name>` blocks with `when.type`, `when.priority`, `when.source_task_id`, `when.evidence_urls` (`nonempty` or `empty`), one `action`, and an optional `note`.
- First match wins. Put the more specific rule first. The example file pages a high `needs_review` only when `evidence_urls` is nonempty, and otherwise opens `multica issue create --assignee me ...` for `blocked` and `needs_approval`. Normal reviews have no push rule.
- `action` is whitespace-separated argv. No quotes, no pipes, no `&&`, no `$VAR`, no redirection.
- The allowlist's first token is a literal program name. A trailing `*` matches one or more arguments. A token ending in `*` is a prefix (`https://hooks.example/*`).
- The loader rejects a bare `*`, any shell or `sudo`, shell metacharacters, and a wildcard on `node` / `python` and the other interpreters named in `cli/src/notify.ts`.
- `multica issue create --assignee me *` in the example allowlist is a notification target (an issue assigned to the owner), not a dispatch API and not a merge. `multica *` is too broad; do not add it.

## Secrets

Do not put tokens into the policy, the allowlist, the event, or the captain thread. If a webhook needs a signing secret, stop and let the human send it from their own environment. The CLI will not expand `$WEBHOOK` (the `$` is rejected as shell syntax).

## Refusals

- "Just this once" for an unlisted command.
- A notify action whose program is `git` merge, a deploy CLI, or a production SSH. Even if someone allowlists it later, do not propose it from this skill.
- Ping a person who is not the human in this captain thread, unless that policy was already frozen by them.
