import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/cli.js";

const sample = fileURLToPath(new URL("./eval-fixtures/verifier-gates", import.meta.url));

function capture(): { io: Io; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

test("eval fixture matches the check, notify, e2e, and skill baselines", async () => {
  const text = capture();
  assert.equal(await main(["eval", "--fixture", sample], text.io), 0);
  assert.equal(text.stderr(), "");
  assert.match(text.stdout(), /eval verifier-gates {2}ok/);
  assert.match(text.stdout(), /vs baseline/);
  assert.match(text.stdout(), /PASS {2}check\.clean {2}check/);
  assert.match(text.stdout(), /PASS {2}check\.forbidden {2}check/);
  assert.match(text.stdout(), /baseline=false {2}after=false/);
  assert.match(text.stdout(), /\.env forbidden:\.env\*/);
  assert.match(text.stdout(), /PASS {2}notify\.high-empty {2}notify/);
  assert.match(text.stdout(), /baseline=missing_evidence {2}after=missing_evidence/);
  assert.match(text.stdout(), /PASS {2}skill\.ship-e2e {2}skill_text/);
  assert.match(text.stdout(), /PASS {2}e2e\.index {2}e2e_index/);
  assert.match(text.stdout(), /12 passed, 0 failed/);

  const json = capture();
  assert.equal(await main(["eval", "--fixture", sample, "--json"], json.io), 0);
  const report = JSON.parse(json.stdout()) as {
    ok: boolean;
    name: string;
    passed: number;
    failed: number;
    cases: Array<{ id: string; ok: boolean; fields: Array<{ field: string; baseline: string; after: string; ok: boolean }> }>;
  };
  assert.equal(report.ok, true);
  assert.equal(report.name, "verifier-gates");
  assert.equal(report.passed, 12);
  assert.equal(report.failed, 0);
  const forbidden = report.cases.find((item) => item.id === "check.forbidden");
  assert.ok(forbidden);
  assert.equal(forbidden.fields.find((field) => field.field === "ok")?.baseline, "false");
  assert.equal(forbidden.fields.find((field) => field.field === "ok")?.after, "false");
});

test("eval exits non-zero and prints before/after when a checkpoint regresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-eval-"));
  try {
    await cp(sample, root, { recursive: true });
    const manifestPath = join(root, "fixture.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      cases: Array<{ id: string; expect?: { ok?: boolean } }>;
    };
    const clean = manifest.cases.find((item) => item.id === "check.clean");
    assert.ok(clean?.expect);
    clean.expect.ok = false;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const indexPath = join(root, "e2e-index.md");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, index.replace("hand export only", "scripted production login"));

    const captured = capture();
    assert.equal(await main(["eval", "--fixture", root], captured.io), 1);
    assert.match(captured.stdout(), /eval verifier-gates {2}regression/);
    assert.match(captured.stdout(), /FAIL {2}check\.clean/);
    assert.match(captured.stdout(), /! ok\s+baseline=false\s+after=true/);
    assert.match(captured.stdout(), /FAIL {2}e2e\.index/);
    assert.match(captured.stdout(), /after=auth~scripted production login/);
    assert.match(captured.stdout(), /PASS {2}notify\.high-evidence/);
    assert.match(captured.stdout(), /10 passed, 2 failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval keeps going after one checkpoint errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-eval-"));
  try {
    await writeFile(
      join(root, "fixture.json"),
      JSON.stringify({
        name: "partial",
        cases: [
          {
            id: "check.missing",
            kind: "check",
            contract: "missing.md",
            contract_id: "contract_auth",
            head_files: { "src/app.ts": "export const ok = true;\n" },
            expect: { ok: true, changed: ["src/app.ts"], violations: [] },
          },
          {
            id: "skill.present",
            kind: "skill_text",
            file: "skills/ship-e2e/SKILL.md",
            expect: { includes: ["Production is read-only smoke."] },
          },
        ],
      }),
    );
    const captured = capture();
    assert.equal(await main(["eval", "--fixture", root], captured.io), 1);
    assert.match(captured.stdout(), /FAIL {2}check\.missing/);
    assert.match(captured.stdout(), /fixture input not found: missing.md/);
    assert.match(captured.stdout(), /PASS {2}skill\.present/);
    assert.match(captured.stdout(), /1 passed, 1 failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval rejects a missing fixture, a bad manifest, and a drifted skill phrase", async () => {
  const missing = capture();
  assert.equal(await main(["eval", "--fixture", join(tmpdir(), "no-such-crewvane-fixture")], missing.io), 1);
  assert.match(missing.stderr(), /fixture not found/);

  const bad = await mkdtemp(join(tmpdir(), "crewvane-eval-"));
  try {
    await writeFile(join(bad, "fixture.json"), JSON.stringify({ name: "bad", cases: [{ id: "x", kind: "model" }] }));
    const unknown = capture();
    assert.equal(await main(["eval", "--fixture", bad], unknown.io), 1);
    assert.match(unknown.stderr(), /unknown checkpoint kind: model/);
    assert.equal(unknown.stdout(), "");

    const skill = await mkdtemp(join(tmpdir(), "crewvane-eval-"));
    try {
      await writeFile(
        join(skill, "fixture.json"),
        JSON.stringify({
          name: "skill-miss",
          cases: [
            {
              id: "skill.missing",
              kind: "skill_text",
              file: "skills/ship-e2e/SKILL.md",
              expect: { includes: ["THIS PHRASE IS NOT IN THE SKILL"] },
            },
          ],
        }),
      );
      const drifted = capture();
      assert.equal(await main(["eval", "--fixture", skill, "--json"], drifted.io), 1);
      const report = JSON.parse(drifted.stdout()) as { ok: boolean; cases: Array<{ fields: Array<{ after: string }> }> };
      assert.equal(report.ok, false);
      assert.match(report.cases[0]?.fields[0]?.after ?? "", /missing: THIS PHRASE IS NOT IN THE SKILL/);
    } finally {
      await rm(skill, { recursive: true, force: true });
    }
  } finally {
    await rm(bad, { recursive: true, force: true });
  }
});

test("help mentions eval", async () => {
  const helped = capture();
  assert.equal(await main(["--help"], helped.io), 0);
  assert.match(helped.stdout(), /eval --fixture DIR/);
  assert.match(helped.stdout(), /non-zero on regression/);
});
