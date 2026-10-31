# Notify policy (example)

The v0 runner does not call a model. It parses each `## Rule:` block below
and takes the first rule whose `when.` lines all match the event. Prose
outside those blocks is for the captain to read and is ignored by the parser.

A match only produces a dry-run plan. The plan names an argv list. It does
not start that program, expand environment variables, or read a secret.
Merging to main and deploying to production are out of scope even when
`allow` is true.

Do not put tokens, signing keys, or webhook secrets in this file. Do not add
a rule whose action is a shell pipeline. The example allowlist is
`templates/notify.allowlist.example.json`.

## Rule: high priority page

when.priority: high
when.type: needs_review
action: curl -X POST https://hooks.example/ship
note: Tell the human a high-priority review is waiting. Do not merge or deploy.

## Rule: captain inbox

when.type: needs_review
action: multica inbox push
note: Surface the packet where the captain already looks. Still no merge or deploy.

## Never

- Do not treat `executed: false` as a suggestion to run the action yourself.
- Do not widen the allowlist to `*`, to a shell, or to `sudo`.
- Do not add a second channel that the allowlist does not already name.
