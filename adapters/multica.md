# Multica

v0 does not ship a Multica client. Dispatch still goes through `generic.md`.
Map `spawn`, `status`, and `collect` onto Multica's own task API the same way
the Herdr and Orca notes do: one frozen slice in, evidence out, no merge, no
production deploy. Do not invent Multica endpoint paths in the captain thread.

`multica` also appears in `templates/notify.allowlist.example.json` as a
notification target, not as dispatch:

```text
multica issue create --assignee me *
```

The example policy uses that shape for `blocked` and `needs_approval`:

```text
multica issue create --assignee me --title blocked
multica issue create --assignee me --title needs-approval
```

`notify dry-run` only prints the plan. `notify run` may start that exact argv
with no shell, after the allowlist matches. A broad `multica *` is not in the
example allowlist. Neither command merges or deploys.
