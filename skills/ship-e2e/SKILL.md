---
name: ship-e2e
description: >-
  Slash command /ship-e2e. The skill name is ship-e2e, matching that command,
  so hosts that support skills load this file when the human types /ship-e2e.
  Set up shared Playwright login and short smoke tests: one auth.setup.ts and
  storageState per project and environment, a Features table the contract
  checks as feature:<id>, read-only production smoke, and evidence rows with
  Claim feature:<id>, Kind e2e, pointing at the report. Also use when the
  human mentions e2e, login, storageState, Playwright, smoke, captcha, or
  production acceptance.
---

# ship-e2e

Browser acceptance for a slice the captain is already shipping. Delivery
order is `templates/workflow.md` in the kit (`$HOME/.agent-ship-kit/current/templates/`).
The login index template is `e2e.md`. The pattern to copy into the project
under test is `e2e-testing.md`. Those files live in that same templates
directory. A manual clone keeps them under `templates/`.

This skill does not merge, deploy, or collect passwords.

## When to use

- The contract's acceptance includes a logged-in smoke test or `feature:<id>`.
- Login, captcha, SMS, or a shared session is blocking a worker.
- The human asks for production acceptance.

## When not to use

- The slice has no UI. Do not invent a browser suite.
- Someone asks for the password, a cookie, or the contents of a storageState
  file. Refuse. Tell them those stay in a password manager or a local
  untracked env file.

## Shared login

1. Copy `$HOME/.agent-ship-kit/current/templates/e2e.md` to
   `.agent-ship/e2e/index.md` if that index does not exist yet. Add a row for
   this project and environment. Do not reuse another project's row. On that
   same index, keep the login rows and fill the Features table: `id`, the
   route or UI entry, and a one-line assertion. A contract may check
   `feature:<id>` only for an id in that table. Do not open a second feature
   map.
2. Add one `auth.setup.ts` for this project, following
   `$HOME/.agent-ship-kit/current/templates/e2e-testing.md`. It writes `storageState` to the path on that
   row. Smoke specs depend on the setup project and reuse the file. They do
   not log in again.
3. Credentials are environment variables (`E2E_USERNAME`, `E2E_PASSWORD`,
   `E2E_BASE_URL`, `E2E_STORAGE_STATE`). Name them. Do not ask the human to
   paste the values into chat, and do not write the values into the repo,
   the skill, the contract, or the inbox.
4. Confirm `.agent-ship/e2e/` and `*.storage-state.json` are gitignored
   before any login runs. If a state file shows up in `git status`, stop and
   unstage it. Do not open the file into context.

## System-side needs

Scripted login is allowed only when the environment already has:

- a dedicated test account
- a scriptable login, or a test-env bypass for captcha and SMS
- a session that lasts through the smoke suite (30 minutes unless the project
  says otherwise)

If any of those are missing, `inbox add --type blocked` with a one-line
summary and stop. Do not bypass production captcha or SMS yourself, and do
not ask the owner to turn production checks off.

## Production

Production is read-only smoke. The owner logs in once by hand and exports a
short-lived storageState to the gitignored path on the production row. You
record that the file exists. You do not read it. When smoke fails because the
session expired, ask the owner to export again. Do not run the staging
`auth.setup.ts` against production, and do not type a production password.

Read-only means navigation and assertions on what is already on the page. No
mutating requests.

## Evidence

Contracts may check `feature:<id>` from the Features table. The verifier and
the review packet each use one row per id that was checked:

- Claim: `feature:<id>`
- Kind: `e2e`
- Pointer: the Playwright report path or the CI URL
- Result: `pass`, `fail`, or `not run`

The pointer is a report. It is never a storageState path, a cookie, or a
password. That report URL goes into `evidence_urls` when you `inbox add` the
`needs_review`. Do not put the storageState path in `evidence_urls`. A high
priority review still needs a real evidence URL; an empty list is not paged.

## Re-login

When the session expires, re-run setup for a test environment, or ask for a
new hand export in production. Delete the stale gitignored file only as a
local cleanup. Do not commit the replacement.
