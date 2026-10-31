---
name: ship-notify
description: >-
  Plan a human notification from a markdown policy and an argv allowlist,
  dry-run only. Use when a needs_review event should reach the human, when
  editing notify policy, or when running agent-ship notify dry-run.
---

# ship-notify

Notification is a dry-run plan. v0 does not start the planned command, does
not open a shell, and does not expand environment variables.

Policy: `templates/notify.policy.example.md` (or the human's copy).
Allowlist: `templates/notify.allowlist.example.json` (or the human's copy).
The parser and the match rules are normative in `docs/ARCHITECTURE.md`.

## When to use

- A `needs_review` event was just written and the human might need a ping.
- The human asks how they will be reached.
- You are about to add a channel, a webhook, or a command. Stop and change policy plus allowlist first, with the human's edit.

## Dry-run

```bash
cd cli
npm run agent-ship -- notify dry-run --root .. --latest \
  --policy ../templates/notify.policy.example.md \
  --allowlist ../templates/notify.allowlist.example.json
```

Use `--event <file.json>` instead of `--latest` when the event is not the newest inbox line.

Read the JSON plan:

| Field | Meaning |
| --- | --- |
| `executed` | Always `false` in v0. |
| `allow` | The action's argv matched an allowlist pattern. |
| `reason` | `allowlisted`, `not_allowlisted`, `no_matching_rule`, `shell_metacharacter`, `shell_interpreter`, or `empty_action`. |
| `matched_rule` | First policy rule whose `when.` lines all matched. |
| `argv` | The planned argument vector, or null if the action was rejected as shell syntax. |
| `pattern` | The allowlist pattern that matched, if any. |

Show that JSON to the human. Do not "helpfully" run `argv` in a terminal.

## If `allow` is false

Say the reason in plain language. Do not rewrite the action into a nearby command that would pass. Do not add a temporary allowlist entry. Ask the human to edit the policy and the allowlist if a different reach-out is actually wanted.

## If `allow` is true

Say which rule matched and which pattern allowed it. Still do not execute it. v0 has no `notify run` command. If the human wants the ping to go out, they run their own allowed tool, or a later version of this kit will, with `shell: false` and this same allowlist. A passing dry-run is not permission to merge or deploy.

## Editing policy

- Rules are `## Rule: <name>` blocks with `when.type`, `when.priority`, `when.source_task_id`, one `action`, and an optional `note`.
- First match wins. Put the more specific rule first. The example file pages on `priority: high` and otherwise files `multica inbox push`.
- `action` is whitespace-separated argv. No quotes, no pipes, no `&&`, no `$VAR`, no redirection.
- The allowlist's first token is a literal program name. A trailing `*` matches one or more arguments. A token ending in `*` is a prefix (`https://hooks.example/*`).
- The loader rejects a bare `*`, any shell or `sudo`, shell metacharacters, and a wildcard on `node` / `python` and the other interpreters named in `cli/src/notify.ts`.
- `multica *` in the example allowlist is a notification target, not a dispatch API and not a merge.

## Secrets

Do not put tokens into the policy, the allowlist, the event, or the captain thread. If a webhook needs a signing secret, stop and let the human send it from their own environment. The CLI will not expand `$WEBHOOK` (the `$` is rejected as shell syntax).

## Refusals

- "Just this once" for an unlisted command.
- A notify action whose program is `git` merge, a deploy CLI, or a production SSH. Even if someone allowlists it later, do not propose it from this skill.
- Ping a person who is not the human in this captain thread, unless that policy was already frozen by them.
