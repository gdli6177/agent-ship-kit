# E2E testing 端到端测试

How a project under this kit logs in once and reuses that session for short
smoke tests. The index of projects and environments is [e2e.md](e2e.md).
The captain's procedure is `skills/ship-e2e/SKILL.md`. This file is the
pattern to copy into the project under test. agent-ship-kit does not ship a
Playwright dependency of its own.

## Shared login

Each project has one Playwright `auth.setup.ts`. It logs in and saves
`storageState`. Smoke specs depend on that setup and reuse the file. They do
not log in again.

```ts
// tests/e2e/<project>/auth.setup.ts
import { test as setup } from "@playwright/test";

const statePath = process.env.E2E_STORAGE_STATE;
if (!statePath) throw new Error("E2E_STORAGE_STATE is not set");

setup("authenticate", async ({ page }) => {
  await page.goto(process.env.E2E_BASE_URL ?? "");
  await page.getByLabel("Email").fill(process.env.E2E_USERNAME ?? "");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.context().storageState({ path: statePath });
});
```

```ts
// playwright.config.ts (sketch)
import { defineConfig } from "@playwright/test";

export default defineConfig({
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "smoke",
      testMatch: /.*\.smoke\.spec\.ts/,
      dependencies: ["setup"],
      use: { storageState: process.env.E2E_STORAGE_STATE },
    },
  ],
});
```

Username and password come from the environment of the test run. They are not
literals in the setup file, not committed, and not typed into the captain
thread. A local untracked env file or the password manager is the source. The
captain may say which variable names are required. The captain does not ask
for the values.

Point `E2E_STORAGE_STATE` at the path in the index row, for example
`.agent-ship/e2e/A.staging.storage-state.json`. That directory is gitignored.

## One setup per project

Project A and project B do not share `auth.setup.ts` or a storageState file.
Within one project, each environment has its own index row and its own
storageState path. Reuse the same setup module by changing `E2E_BASE_URL` and
`E2E_STORAGE_STATE`. Do not point staging smoke at a production state file.

## What the system under test must provide

The kit cannot click through a captcha or an SMS challenge on the agent's
behalf. Before scripted login will work, the environment needs:

- A dedicated test account, not a personal owner account.
- Either a scriptable login, or a test-environment bypass for captcha and SMS.
- A session lifetime long enough to finish the smoke suite. Treat 30 minutes
  as the floor unless the project documents a different one. When the session
  expires, re-run setup. Do not keep using a dead state file.

If those are missing, file `inbox add --type blocked` and stop. Do not weaken
production auth to make the test pass.

## Production acceptance

Production smoke is read-only: open pages, read what is on the screen, stop.
No posts that change data, no deletes, no purchases, no settings writes.

The owner logs in once by hand and exports a short-lived storageState to the
gitignored path on that project's production row. Tell the captain only that
the file is in place. Do not paste the file, cookies, or the password into
chat. When the session expires, stop and ask the owner to export again.
Do not script a production password login.

## Evidence on the review packet

Each smoke run becomes one row on `templates/review-packet.md`:

| Claim | Kind | Pointer | Result |
| --- | --- | --- | --- |
| E2E smoke A staging | e2e | `playwright-report/` or the CI URL | pass / fail |

The pointer is a report the human can open. It is not the storageState path
and it is not a cookie. A failed or skipped smoke is `fail` or `not run`,
with the reason in the packet. It is not a silent pass.
