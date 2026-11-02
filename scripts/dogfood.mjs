// Opt-in trial: real installer, Git hooks, OS scheduler, independent OMP worker/verifier.
// Creates disposable projects only. Does not push, merge, send messages or touch user projects.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = await realpath(await mkdtemp(join(tmpdir(), "agent-ship-dogfood-")));
const home = join(sandbox, "installer-home"), project = join(sandbox, "project"), worker = join(sandbox, "worker");
const report = { sandbox, platform: process.platform, started_at: new Date().toISOString(), checks: [], ok: false };
const reportFile = process.env.AGENT_SHIP_DOGFOOD_REPORT ?? join(sandbox, "report.json");
async function run(cmd, args, options = {}) {
  try { const pending = exec(cmd, args, { cwd: project, timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }); pending.child.stdin.end(); const r = await pending; return { code: 0, ...r }; }
  catch (error) { return { code: typeof error.code === "number" ? error.code : 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), message: error.message }; }
}
async function pass(name, action) {
  process.stdout.write(`${name} ...\n`);
  const evidence = await action();
  report.checks.push({ name, passed: true, evidence: evidence ?? null });
  await writeFile(reportFile, JSON.stringify(report, null, 2));
}
let env, cli;
async function ship(...args) {
  const result = await run(cli, [...args, "--root", project], { env });
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
async function git(...args) { const r = await run("git", args); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); }
try {
  await mkdir(project); await mkdir(home);
  for (const host of ["codex", "qoder", "kiro", "omp", "agents"]) await mkdir(join(home, `.${host}`));
  const tarball = join(sandbox, "kit.tar.gz");
  const archive = await run("tar", ["-czf", tarball, "--exclude", "node_modules", "--exclude", ".git", "-C", source, "."], { cwd: sandbox }); assert.equal(archive.code, 0, archive.stderr);
  // HOME is isolated only for the installer child; the operator's shell and OMP auth stay untouched.
  const installer = join(sandbox, "install.sh");
  await writeFile(installer, await readFile(join(source, "install.sh")));
  env = { ...process.env, HOME: home, AGENT_SHIP_TARBALL: tarball, AGENT_SHIP_TIMER_HOME: home, AGENT_SHIP_LAUNCH_AGENTS_DIR: join(home, "Library/LaunchAgents"), npm_config_cache: join(home, "npm-cache") };
  delete env.AGENT_SHIP_TIMER_PLATFORM; delete env.AGENT_SHIP_LAUNCHCTL_CMD; delete env.AGENT_SHIP_CRONTAB_CMD;
  await pass("Install archive through the real installer into isolated host directories", async () => {
    const r = await run("bash", [installer, "--ref", "release-trial"], { cwd: sandbox, env }); assert.equal(r.code, 0, r.stderr);
    cli = join(home, ".local/bin/agent-ship");
    const targets = [".codex/skills", ".qoder/skills", ".kiro/skills", ".omp/agent/skills", ".agents/skills"];
    for (const target of targets) assert.equal((await readdir(join(home, target))).filter(n => n.startsWith("ship-")).length, 7);
    return { hosts: targets, kit_ref: "release-trial" };
  });
  await git("init", "-b", "main"); await git("config", "user.name", "Dogfood fixture operator"); await git("config", "user.email", "dogfood@example.invalid");
  await mkdir(join(project, "src")); await mkdir(join(project, "test"));
  await writeFile(join(project, "AGENTS.md"), "# Fixture owner rules\nOnly touch paths in the frozen contract. Never push, merge, deploy, read credentials or change hooks. Assigned workers execute their slice; verifiers do not edit source.\n");
  await writeFile(join(project, "src/math.mjs"), "export function add(a, b) { return a + b; }\n");
  await writeFile(join(project, "test/math.test.mjs"), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('addition', () => assert.equal(add(2, 3), 5));\n");
  await git("add", "AGENTS.md", "src/math.mjs", "test/math.test.mjs"); await git("commit", "-m", "fixture baseline");
  await pass("Local rules visibility and real unauthorized commit rejection", async () => {
    const setup = await ship("setup"); assert.equal(setup.rules_auto_loaded, false); assert.ok(setup.warnings.length);
    await writeFile(join(project, "src/math.mjs"), "export function add(a, b) { return a + b; }\n// fixture probe\n"); await git("add", "src/math.mjs");
    const blocked = await run("git", ["commit", "-m", "must be rejected"]); assert.notEqual(blocked.code, 0);
    await writeFile(join(project, "src/math.mjs"), "export function add(a, b) { return a + b; }\n"); await git("add", "src/math.mjs");
    return { rules_auto_loaded: setup.rules_auto_loaded, unauthorized_commit_exit: blocked.code };
  });
  await ship("setup", "--shared");
  await ship("intake", "--direct", "--id", "bootstrap", "--text", "Record fixture shared onboarding only.", "--allowed", "AGENTS.md", "--allowed", ".gitignore", "--allowed", "agent-ship.team.json", "--allowed", "docs/agent-team/**", "--forbidden", "src/**", "--accepted-by", "Dogfood fixture operator", "--accepted-text", "Explicit test authorization to commit generated onboarding files.");
  await git("add", "AGENTS.md", ".gitignore", "agent-ship.team.json", "docs/agent-team/handbook.md", "docs/agent-team/lessons/README.md"); await git("commit", "-m", "fixture onboarding");
  const proposal = await ship("intake", "--id", "proposal_math", "--text", "Add subtract(a,b), preserve add, and test zero and negative results.");
  assert.equal(proposal.status, "draft");
  assert.notEqual((await run(cli, ["guard", "--root", project], { env })).code, 0);
  let lesson;
  await pass("Pre-dispatch correction, candidate review, automatic scoped recall and handbook diff", async () => {
    const c = await ship("correction", "add", "--text", "Arithmetic changes must include zero and negative cases.", "--scope", "lesson", "--source", "proposal:proposal_math", "--project", "math", "--when", "When changing arithmetic functions.", "--action", "Include tests for zero and negative results.", "--tag", "verify", "--corrected-by", "Dogfood fixture operator");
    lesson = c.extraction.items[0].id;
    assert.equal((await ship("team", "context", "--auto", "--project", "math")).lessons.length, 0);
    await ship("lesson", "review", "--id", lesson, "--status", "active", "--reviewed-by", "Fixture maintainer", "--note", "Fixture-only explicit approval after checking applicability.");
    const context = await ship("team", "context", "--auto", "--project", "math"); assert.equal(context.lessons[0].id, lesson); assert.ok(context.handbook.excerpt);
    assert.equal((await ship("team", "context", "--auto", "--project", "other")).lessons.length, 0);
    const before = await readFile(join(project, "docs/agent-team/handbook.md"), "utf8");
    const diff = await ship("handbook", "propose", "--from-lesson", lesson); assert.ok(diff.diff.includes("+"));
    assert.equal(await readFile(join(project, "docs/agent-team/handbook.md"), "utf8"), before);
    return { lesson, cross_project_matches: 0, handbook_written: false };
  });
  // This fixture records authorization given by its operator; it is not a production human decision.
  await writeFile(join(project, ".agent-ship/contracts/math.md"), `Status: frozen\nFrozen by: Dogfood fixture operator\nFrozen at: ${new Date().toISOString()}\nProposal id: proposal_math\nAccepted text: Add subtract(a,b), preserve add, and test zero and negative results.\nAccepted by: Dogfood fixture operator\nAccepted at: ${new Date().toISOString()}\n## Allowed paths\n- src/math.mjs\n- test/math.test.mjs\n## Forbidden paths\n- AGENTS.md\n- .env*\n- .git/**\n## Acceptance\n- node --test test/math.test.mjs\n- add remains correct; subtract covers zero and negative results.\n## Slices\nmax_parallel: 1\n| a | contract | acceptance passes |\n`);
  await git("worktree", "add", "-b", "ship/math/a", worker, "main");
  const setup = await run(cli, ["setup", "--root", worker, "--state-root", project], { env }); assert.equal(setup.code, 0, setup.stdout + setup.stderr);
  await pass("Real scheduler registration, execution and health (no scheduler mocks)", async () => {
    const dispatch = await ship("slice", "start", "--contract", "math", "--slice", "a", "--repo", worker, "--branch", "ship/math/a", "--source-task-id", "math_task", "--worker", "omp-worker-trial", "--proposal", "proposal_math", "--project", "math", "--tag", "verify", "--title", "Subtract", "--summary", "Real isolated arithmetic worker.");
    assert.equal(dispatch.timer.registered, true);
    if (process.platform === "darwin") {
      const slug = (await import("node:crypto")).createHash("sha256").update(project).digest("hex").slice(0, 16);
      const result = await run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.agent-ship.watchdog.${slug}`]); assert.equal(result.code, 0, result.stderr);
      let status;
      for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); status = await ship("watchdog", "status"); if (status.healthy === true && status.last_run_at) break; }
      assert.equal(status.healthy, true); assert.ok(status.runs > 0); assert.ok(status.last_run_at); assert.equal(status.last_exit_code, 0);
      return status;
    }
    throw new Error("Real scheduler completion trial currently requires macOS; do not claim the Linux cron runtime has been exercised.");
  });
  const model = process.argv.find(arg => arg.startsWith("--model="))?.slice(8) ?? process.env.OMP_DELEGATE_MODEL ?? "opencode-go/deepseek-v4-flash";
  await pass("Independent real OMP worker executes the frozen slice", async () => {
    const brief = join(sandbox, "worker.md");
    await writeFile(brief, `You are the WORKER, not captain. Work only in ${worker}. Read AGENTS.md and frozen contract ${project}/.agent-ship/contracts/math.md. Implement its arithmetic request, edit only src/math.mjs and test/math.test.mjs. Run node --test test/math.test.mjs. Do not commit, push, merge, deploy, change hooks, read credentials or edit other files. Return concise evidence.\n`);
    const r = await run("omp", ["-p", "--model", model, "--auto-approve", "--no-session", "--max-time", "3m", "--cwd", worker, `@${brief}`], { cwd: sandbox, timeout: 210000 });
    await writeFile(join(sandbox, "worker-result.txt"), r.stdout + r.stderr); assert.equal(r.code, 0, `OMP worker failed; inspect ${sandbox}/worker-result.txt`);
    const acceptance = await run(process.execPath, ["--test", "test/math.test.mjs"], { cwd: worker }); assert.equal(acceptance.code, 0, acceptance.stderr);
    const sourceText = await readFile(join(worker, "src/math.mjs"), "utf8"); assert.match(sourceText, /subtract/);
    const staged = await run("git", ["add", "src/math.mjs", "test/math.test.mjs"], { cwd: worker }); assert.equal(staged.code, 0);
    const commit = await run("git", ["commit", "-m", "fixture subtract slice"], { cwd: worker }); assert.equal(commit.code, 0, commit.stdout + commit.stderr);
    return { runtime: "omp", model, acceptance_exit: acceptance.code, real_guarded_commit_exit: commit.code };
  });
  await ship("slice", "update", "--source-task-id", "math_task", "--status", "running", "--worker", "omp-worker-trial", "--summary", "Worker completed guarded arithmetic commit.");
  await pass("Separate OMP verifier independently checks branch and acceptance", async () => {
    const brief = join(sandbox, "verifier.md");
    await writeFile(brief, `You are an independent READ-ONLY VERIFIER. Do not edit, commit or read worker logs. Work in ${worker}. Read AGENTS.md and frozen contract ${project}/.agent-ship/contracts/math.md. Inspect git diff main...ship/math/a and rerun node --test test/math.test.mjs. Independently assert exported add(2,3)=5, subtract(2,3)=-1 and subtract(2,2)=0 with node. Return AGREE only if all pass. No credentials, network, push, merge or deploy.\n`);
    const r = await run("omp", ["-p", "--model", model, "--auto-approve", "--no-session", "--max-time", "3m", "--cwd", worker, `@${brief}`], { cwd: sandbox, timeout: 210000 });
    await writeFile(join(sandbox, "verifier-result.txt"), r.stdout + r.stderr); assert.equal(r.code, 0, `Verifier failed; inspect ${sandbox}/verifier-result.txt`); assert.match(r.stdout, /\bAGREE\b/); assert.doesNotMatch(r.stdout, /\bDISAGREE\b/);
    const check = await ship("check", "--contract", "math", "--slice", "a"); assert.equal(check.ok, true); assert.equal(check.applicable_lessons[0].id, lesson);
    await ship("lesson", "check", "--source-task-id", "math_task", "--outcome", "none", "--reason", "Arithmetic acceptance and existing lesson cover this slice.", "--reviewed-by", "omp-verifier-trial");
    const item = await ship("inbox", "add", "--title", "Arithmetic trial ready", "--summary", "Separate verifier passed acceptance and scope checks.", "--source-task-id", "math_task", "--evidence", "fixture:independent-verifier", "--contract", "math");
    assert.equal(item.applicable_lessons[0].id, lesson);
    assert.equal((await ship("watchdog")).noop, true);
    assert.equal((await ship("watchdog", "status")).registered, true);
    // Do not impersonate a user's final acceptance; leave the fixture inbox item waiting.
    await ship("learning", "review", "--outcome", "candidate", "--reason", "Fixture correction was captured and reviewed; no additional reusable finding.");
    return { independent_verifier_exit: r.code, check_ok: true, inbox: item.id, final_human_acceptance: "pending (fixture)", timer_retained: true };
  });
  report.ok = true;
} catch (error) {
  report.error = error.stack ?? error.message;
  process.exitCode = 1;
} finally {
  if (cli) {
    const cleanup = await run(cli, ["watchdog", "uninstall", "--root", project], { env });
    report.timer_cleanup_exit = cleanup.code;
    if (cleanup.code !== 0) { report.ok = false; process.exitCode = 1; }
  }
  report.finished_at = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  process.stdout.write(`Trial ${report.ok ? "passed" : "FAILED"}; report: ${reportFile}\n`);
  if (report.error) process.stderr.write(`${report.error}\n`);
}
