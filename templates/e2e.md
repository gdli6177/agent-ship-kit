# E2E index 端到端索引

Copy this file to `.agent-ship/e2e/index.md` and fill one row per project and
environment. That copy is gitignored. The storageState files it points at are
gitignored too. Do not paste those files, cookies, or passwords into git, a
skill, or the captain chat.

One auth setup per project. The same project does not share a storageState
across environments, and project A does not share one with project B.

| Project 项目 | Environment 环境 | Auth setup | storageState（gitignore，勿提交） | Smoke 冒烟 |
| --- | --- | --- | --- | --- |
| A | staging | `tests/e2e/a/auth.setup.ts` | `.agent-ship/e2e/A.staging.storage-state.json` | `tests/e2e/a/app.smoke.spec.ts` |
| A | production | hand export only 仅人工导出 | `.agent-ship/e2e/A.production.storage-state.json` | `tests/e2e/a/readonly.smoke.spec.ts` |
| B | staging | `tests/e2e/b/auth.setup.ts` | `.agent-ship/e2e/B.staging.storage-state.json` | `tests/e2e/b/app.smoke.spec.ts` |

## How to read a row

- **Project** is one product or deployable. It gets its own `auth.setup.ts`.
- **Environment** is staging, a test env, or production. Production rows are
  read-only smoke. The owner logs in by hand and exports a short-lived
  storageState. There is no scripted production password login.
- **Auth setup** is the Playwright setup project that writes the storageState.
  Leave this cell as "hand export only" for production.
- **storageState** is a path under `.agent-ship/e2e/`. The captain may know the
  path. The captain does not open the file.
- **Smoke** reuses that storageState. Record the Playwright report path on the
  review packet. Do not attach the storageState.

## Features 功能

One row per behavior a contract can accept. The id is stable. A contract
checks it as `feature:<id>`. Entry is the route or the UI the smoke opens.
Assertion is one line a human can match to the report. This table is not a
second document. Do not put passwords, cookies, or storageState contents here.

| id | entry (route/UI entry) 路由或界面入口 | assertion (one-line) 一行 |
| --- | --- | --- |
| login | `/login` | Test account signs in and the app shell is visible |
| home | `/` | Signed-in home shows the project name |

Each id is its own evidence row: Claim `feature:<id>`, Kind `e2e`, pointer
the Playwright report or CI URL. The pointer is never a storageState file.

## When a session dies

Re-run that row's setup (staging / test) or ask the owner to export again
(production). Do not invent a password, and do not copy another row's file.

Details: [e2e-testing.md](e2e-testing.md). Delivery loop: [workflow.md](workflow.md).
