# E2E index

Fixture input. Production stays a hand export and a read-only smoke.

| Project | Environment | Auth setup | storageState | Smoke |
| --- | --- | --- | --- | --- |
| A | staging | `tests/e2e/a/auth.setup.ts` | `.agent-ship/e2e/A.staging.storage-state.json` | `tests/e2e/a/app.smoke.spec.ts` |
| A | production | hand export only | `.agent-ship/e2e/A.production.storage-state.json` | `tests/e2e/a/readonly.smoke.spec.ts` |
