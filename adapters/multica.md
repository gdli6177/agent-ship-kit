# Multica

v0 does not ship a Multica client. Dispatch still goes through `generic.md`.
Map `spawn`, `status`, and `collect` onto Multica's own task API the same way
the Herdr and Orca notes do: one frozen slice in, evidence out, no merge, no
production deploy. Do not invent Multica endpoint paths in the captain thread.

`multica` also appears in `templates/notify.allowlist.example.json` as:

```text
multica *
```

That pattern is a **notification** target for `ship-notify` (the example rule
plans `multica inbox push` and then does not run it). It is not the dispatch
API, and a dry-run that allows it is not permission to merge or deploy.
A Multica command is still subject to the allowlist; the kit never shells out
to it in v0.
