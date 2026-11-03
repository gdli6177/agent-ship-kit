import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { featureIdsReferenced, featureViolationsInContract, parseFeatureIds } from "../src/features.js";
import { listInbox } from "../src/inbox.js";
import { eventsFile, runWatchdog } from "../src/watchdog.js";

const exec = promisify(execFile);

const loginOnlyIndex = `# E2E index

| Project | Environment | Auth setup | storageState | Smoke |
| --- | --- | --- | --- | --- |
| A | staging | tests/e2e/a/auth.setup.ts | .crewvane/e2e/A.staging.storage-state.json | tests/e2e/a/app.smoke.spec.ts |
`;

const featuresIndex = `${loginOnlyIndex}
## Features 功能

| id | entry (route/UI entry) | assertion (one-line) |
| --- | --- | --- |
| login | \`/login\` | Test account signs in and the app shell is visible |
| home | \`/\` | Signed-in home shows the project name |
| login | duplicate | ignored |
`;

function contract(acceptance: string): string {
  return `# Contract

## Acceptance 验收

${acceptance}

## Allowed paths 允许改动的路径

- src/**

## Forbidden paths 禁止改动的路径

- secrets/**
`;
}

async function git(root: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crewvane-features-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "base"]);
  await mkdir(join(root, ".crewvane", "contracts"), { recursive: true });
  return root;
}

function capture(): { io: { stdout: (chunk: string) => void; stderr: (chunk: string) => void }; stdout: () => string } {
  const out: string[] = [];
  return {
    io: {
      stdout: (chunk) => out.push(chunk),
      stderr: () => undefined,
    },
    stdout: () => out.join(""),
  };
}

test("feature ids are read from feature:<id> and not from placeholders", () => {
  const ids = featureIdsReferenced(
    "Check `feature:login` and feature:home. Also feature:auth.login, feature:login. Skip feature:<id> and myfeature:nope.",
  );
  assert.deepEqual(ids, ["login", "home", "auth.login"]);
});

test("a login index without a Features table does not yield ids", () => {
  assert.equal(parseFeatureIds(loginOnlyIndex), null);
  assert.equal(parseFeatureIds("## Features 功能\n\nNo table yet.\n"), null);
  assert.equal(parseFeatureIds("## Features\n\n| name | entry |\n| --- | --- |\n| login | / |\n"), null);
});

test("the Features table yields ids, including when id is not the first column", () => {
  assert.deepEqual(parseFeatureIds(featuresIndex), ["login", "home"]);
  const swapped = `## Features

| assertion (one-line) | id | entry (route/UI entry) |
| --- | --- | --- |
| visible | \`billing\` | /billing |
| <skip> | <id> | /nope |
`;
  assert.deepEqual(parseFeatureIds(swapped), ["billing"]);
});

test("the shipped e2e template exposes login and home", async () => {
  const template = await readFile(new URL("../../templates/e2e.md", import.meta.url), "utf8");
  assert.deepEqual(parseFeatureIds(template), ["login", "home"]);
  const card = await readFile(new URL("../../templates/contract-card.md", import.meta.url), "utf8");
  assert.deepEqual(featureIdsReferenced(card), []);
});

test("missing index or missing Features table leaves feature refs unchecked", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-features-skip-"));
  try {
    const markdown = contract("- [ ] `feature:missing`");
    assert.deepEqual(await featureViolationsInContract(root, markdown), []);
    await mkdir(join(root, ".crewvane", "e2e"), { recursive: true });
    await writeFile(join(root, ".crewvane", "e2e", "index.md"), loginOnlyIndex);
    assert.deepEqual(await featureViolationsInContract(root, markdown), []);
    assert.deepEqual(await featureViolationsInContract(root, contract("- [ ] typecheck passes")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check fails only for feature ids missing from a present Features table", async () => {
  const root = await repo();
  try {
    await mkdir(join(root, ".crewvane", "e2e"), { recursive: true });
    await writeFile(join(root, ".crewvane", "e2e", "index.md"), featuresIndex);
    await writeFile(
      join(root, ".crewvane", "contracts", "contract_auth.md"),
      contract("- [ ] `feature:login`\n- [ ] feature:missing"),
    );

    const bad = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], bad.io), 1);
    const badResult = JSON.parse(bad.stdout());
    assert.equal(badResult.ok, false);
    assert.deepEqual(badResult.violations, []);
    assert.deepEqual(badResult.feature_violations, [{ id: "missing", rule: "unknown_feature" }]);

    await writeFile(join(root, ".crewvane", "contracts", "contract_auth.md"), contract("- [ ] `feature:login`\n- [ ] `feature:home`"));
    const good = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], good.io), 0);
    const goodResult = JSON.parse(good.stdout());
    assert.equal(goodResult.ok, true);
    assert.equal("feature_violations" in goodResult, false);

    await writeFile(join(root, ".crewvane", "e2e", "index.md"), loginOnlyIndex);
    await writeFile(join(root, ".crewvane", "contracts", "contract_auth.md"), contract("- [ ] `feature:missing`"));
    const unchanged = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], unchanged.io), 0);
    const unchangedResult = JSON.parse(unchanged.stdout());
    assert.equal(unchangedResult.ok, true);
    assert.equal("feature_violations" in unchangedResult, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check reports path drift and an unknown feature id together", async () => {
  const root = await repo();
  try {
    await mkdir(join(root, ".crewvane", "e2e"), { recursive: true });
    await writeFile(join(root, ".crewvane", "e2e", "index.md"), featuresIndex);
    await writeFile(join(root, ".crewvane", "contracts", "contract_auth.md"), contract("- [ ] `feature:missing`"));
    await git(root, ["checkout", "-b", "ship/contract_auth/slice"]);
    await writeFile(join(root, "notes.txt"), "outside\n");
    await git(root, ["add", "notes.txt"]);
    await git(root, ["commit", "-m", "outside"]);

    const both = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], both.io), 1);
    const result = JSON.parse(both.stdout());
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].path, "notes.txt");
    assert.deepEqual(result.feature_violations, [{ id: "missing", rule: "unknown_feature" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog names a missing feature id when that is why check failed", async () => {
  const root = await repo();
  try {
    await mkdir(join(root, ".crewvane", "e2e"), { recursive: true });
    await writeFile(join(root, ".crewvane", "e2e", "index.md"), featuresIndex);
    await writeFile(join(root, ".crewvane", "contracts", "contract_auth.md"), contract("- [ ] `feature:missing`"));
    const now = new Date();
    await writeFile(
      eventsFile(root),
      `${JSON.stringify({
        id: "evt_disp_feature",
        type: "worker_dispatched",
        title: "Auth slice",
        summary: "Dispatched.",
        created_at: now.toISOString(),
        source_task_id: "task_feature",
        contract_id: "contract_auth",
        slice_id: "auth",
        status: "running",
      })}\n`,
    );
    const report = await runWatchdog(root, { now, staleMinutes: 30 });
    assert.equal(report.flagged[0]?.reason, "drift");
    const filed = (await listInbox(root, { openOnly: true }))[0];
    assert.equal(filed?.type, "blocked");
    assert.match(filed?.summary ?? "", /Feature id not in the e2e index: missing/);
    assert.equal((filed?.summary ?? "").includes("Paths drifted"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
