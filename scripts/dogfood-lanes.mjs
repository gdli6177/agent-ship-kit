// Opt-in real trial: isolated installer, two lanes/worktrees, launchd, real OMP workers/verifier.
// Fixture operator approvals are test authorization, not production human authentication.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile), source = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = await realpath(await mkdtemp(join(tmpdir(), "agent-ship-lanes-dogfood-")));
const home = join(sandbox, "installer-home"), project = join(sandbox, "project");
const report = { sandbox, started_at: new Date().toISOString(), checks: [], ok: false };
const reportFile = join(sandbox, "report.json"), workers = {};
const model = process.argv.find(arg => arg.startsWith("--model="))?.slice(8) ?? process.env.OMP_DELEGATE_MODEL;
if (!model) throw new Error("Choose a working OMP model with --model=<provider/model>; this trial does not guess account routes.");
async function run(program, args, options = {}) {
  try { const pending = exec(program, args, { cwd: project, timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }); pending.child.stdin.end(); return { code: 0, ...await pending }; }
  catch (error) { return { code: typeof error.code === "number" ? error.code : 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), message: error.message }; }
}
let cli, env;
async function ship(actor, ...args) { const r = await run(cli, [...args, "--root", project], { env: { ...env, AGENT_SHIP_ACTOR: actor } }); assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}\n${r.stdout}`); return JSON.parse(r.stdout); }
async function git(cwd, ...args) { const r = await run("git", args, { cwd }); assert.equal(r.code, 0, r.stdout + r.stderr); return r.stdout.trim(); }
async function pass(name, action) { process.stdout.write(`${name} ...\n`); const evidence = await action(); report.checks.push({ name, passed: true, evidence }); await writeFile(reportFile, JSON.stringify(report, null, 2)); }
try {
  await mkdir(project); await mkdir(home);
  const archive = join(sandbox, "kit.tar.gz"), installer = join(sandbox, "install.sh");
  assert.equal((await run("tar", ["-czf", archive, "--exclude", "node_modules", "--exclude", ".git", "-C", source, "."], { cwd: sandbox })).code, 0);
  await writeFile(installer, await readFile(join(source, "install.sh")));
  env = { ...process.env, HOME: home, AGENT_SHIP_TARBALL: archive, AGENT_SHIP_TIMER_HOME: home, AGENT_SHIP_LAUNCH_AGENTS_DIR: join(home, "Library/LaunchAgents"), npm_config_cache: join(home, "npm-cache") };
  delete env.AGENT_SHIP_ACTOR; delete env.AGENT_SHIP_TIMER_PLATFORM; delete env.AGENT_SHIP_LAUNCHCTL_CMD; delete env.AGENT_SHIP_CRONTAB_CMD;
  await pass("Real isolated installer and declarative role discovery", async () => {
    const install = await run("bash", [installer, "--ref", "lane-trial"], { cwd: sandbox, env }); assert.equal(install.code, 0, install.stderr);
    cli = join(home, ".local/bin/agent-ship");
    await git(project, "init", "-b", "main"); await git(project, "config", "user.name", "Fixture operator"); await git(project, "config", "user.email", "fixture@example.invalid");
    await mkdir(join(project, "src")); await mkdir(join(project, "test"));
    await writeFile(join(project, "AGENTS.md"), "# Fixture rules\nRead .agent-ship/AGENTS.local.md explicitly. Workers edit only frozen Allowed paths, never hooks/credentials/policy; no push, merge or deployment. Verifiers are read-only.\n");
    for (const lane of ["A", "B"]) {
      await writeFile(join(project, `src/${lane}.mjs`), "export function identity(n) { return n; }\n");
      await writeFile(join(project, `test/${lane}.test.mjs`), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { identity } from '../src/${lane}.mjs';\ntest('identity', () => assert.equal(identity(2), 2));\n`);
    }
    await git(project, "add", "AGENTS.md", "src", "test"); await git(project, "commit", "-m", "fixture baseline");
    await ship("", "setup"); await ship("", "authority", "init", "--human", "fixture-human", "--captain", "captain");
    const roles = await ship("captain", "role", "list"); assert.deepEqual(roles.map(role => role.id), ["generic-worker", "owner", "scout", "verifier"]);
    return { roles: roles.map(role => role.id), authority: "host-bound fixture identities; no real user approval inferred" };
  });
  for (const lane of ["A", "B"]) {
    await pass(`Queue, claim, human fixture freeze and deterministic preparation for lane ${lane}`, async () => {
      const action = lane === "A" ? "double" : "triple", factor = lane === "A" ? 2 : 3;
      await ship("captain", "intake", "add", "--id", `request_${lane}`, "--text", `Add ${action}(n), preserve identity, test zero and negative values.`, "--project", "math", "--by", "fixture-human", "--channel", lane === "B" ? "im" : "chat");
      const entry = await ship("captain", "intake", "claim", `request_${lane}`, "--by", `owner_${lane}`, "--lane", lane);
      if (lane === "B") {
        const guard = await ship("owner_A", "guard", "--lane", "A", "--contract", "contract_A", "--repo", workers.A.repo, "--staged"); assert.equal(guard.ok, true);
        assert.match(await readFile(join(project, `.agent-ship/proposals/${workers.A.proposal}.md`), "utf8"), /Status: draft/);
      }
      const contract = join(project, `.agent-ship/contracts/contract_${lane}.md`);
      await writeFile(contract, `Status: draft\nLane: ${lane}\nOwner: owner_${lane}\nProposal id: ${entry.proposal_id}\n## Allowed paths\n- src/${lane}.mjs\n- test/${lane}.test.mjs\n## Forbidden paths\n- AGENTS.md\n- .env*\n- .git/**\n## Acceptance\n- Export ${action}(n) = n * ${factor}; preserve identity; test 0 and -2.\n- node --test test/${lane}.test.mjs\n## Slices\nmax_parallel: 1\n| Slice id | role | Inputs | Done when |\n| --- | --- | --- | --- |\n| code | generic-worker | this contract | acceptance passes |\n`);
      const impersonation = await run(cli, ["contract", "freeze", "--root", project, "--contract", `contract_${lane}`, "--by", "fixture-human", "--accepted-text", "Owner forged approval"], { env: { ...env, AGENT_SHIP_ACTOR: `owner_${lane}` } }); assert.notEqual(impersonation.code, 0); assert.match(impersonation.stderr, /requires human/);
      await ship("fixture-human", "contract", "freeze", "--contract", `contract_${lane}`, "--by", "fixture-human", "--accepted-text", `Fixture operator authorizes ${action} in lane ${lane}, tests and isolated worker execution.`);
      const repo = join(sandbox, `worker_${lane}`);
      const admission = await ship(`owner_${lane}`, "slice", "open", "--contract", `contract_${lane}`, "--slice", "code", "--lane", lane, "--repo", repo, "--branch", `ship/${lane}/code`, "--source-task-id", `task_${lane}`, "--worker", `omp-lane-${lane}`, "--title", `${action} fixture`, "--summary", "Actual isolated lane worker trial.");
      assert.equal(admission.spawn_required, true); assert.equal(admission.check.ok, true); assert.equal(admission.timer.registered, true);
      workers[lane] = { repo, contract, proposal: entry.proposal_id, role: admission.role, action, factor };
      return { lane_id: admission.lane_id, owner_ref: admission.owner_ref, repo, packet: admission.packet, role: admission.role.id, cross_lane_guard_ok: lane === "B" ? true : null, owner_forgery_exit: impersonation.code };
    });
  }
  await pass("Real launchd completion and healthy runtime receipt with two lanes active", async () => {
    assert.equal(process.platform, "darwin", "This trial requires real macOS launchd; Linux cron is not covered.");
    const slug = createHash("sha256").update(project).digest("hex").slice(0, 16);
    const kick = await run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.agent-ship.watchdog.${slug}`]); assert.equal(kick.code, 0, kick.stderr);
    let health;
    for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 500)); health = await ship("captain", "watchdog", "status"); if (health.healthy === true && health.last_run_at) break; }
    assert.equal(health.healthy, true); assert.equal(health.last_exit_code, 0); assert.ok(health.runs > 0);
    return health;
  });
  await pass("Two independent real OMP workers execute their approved role and slice", async () => {
    return Promise.all(Object.entries(workers).map(async ([lane, worker]) => {
      const brief = join(sandbox, `worker_${lane}.md`);
      await writeFile(brief, `You are the WORKER instance omp-lane-${lane}, not captain or owner. Work only in ${worker.repo}. Read AGENTS.md, .agent-ship/AGENTS.local.md and frozen contract ${worker.contract}.\nRole card:\n${worker.role.markdown}\nImplement only this contract: export ${worker.action}(n), preserve identity, add assertions for 0 and -2. Allowed files src/${lane}.mjs and test/${lane}.test.mjs only. Run node --test test/${lane}.test.mjs. Do not commit, push, merge, deploy, edit hooks/policy, read credentials or change other files. Return command + exit code, evidence pointer, acceptance matrix to owner_${lane}.\n`);
      const r = await run("omp", ["-p", "--model", model, "--auto-approve", "--no-session", "--max-time", "3m", "--cwd", worker.repo, `@${brief}`], { cwd: sandbox, timeout: 210000, env: { ...process.env, AGENT_SHIP_ACTOR: `omp-lane-${lane}` } });
      await writeFile(join(sandbox, `worker_${lane}-result.txt`), r.stdout + r.stderr); assert.equal(r.code, 0, `Inspect ${sandbox}/worker_${lane}-result.txt`);
      const acceptance = await run(process.execPath, ["--test", `test/${lane}.test.mjs`], { cwd: worker.repo }); assert.equal(acceptance.code, 0, acceptance.stdout + acceptance.stderr);
      const semantic = await run(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {identity,${worker.action}} from './src/${lane}.mjs'; assert.equal(identity(2),2); assert.equal(${worker.action}(0),0); assert.equal(${worker.action}(-2),${-2 * worker.factor});`], { cwd: worker.repo }); assert.equal(semantic.code, 0, semantic.stderr);
      await git(worker.repo, "add", `src/${lane}.mjs`, `test/${lane}.test.mjs`); const commit = await git(worker.repo, "commit", "-m", `fixture lane ${lane}`);
      await ship(`owner_${lane}`, "slice", "update", "--lane", lane, "--source-task-id", `task_${lane}`, "--status", "running", "--summary", "Guarded worker commit completed; independent verification pending.");
      return { lane, model, runtime: "omp", acceptance_exit: acceptance.code, semantic_exit: semantic.code, real_guarded_commit: commit.split("\n")[0] };
    }));
  });
  await pass("Independent real OMP verifier checks both branches without worker logs", async () => {
    const brief = join(sandbox, "verifier.md");
    await writeFile(brief, `You are an independent READ-ONLY VERIFIER, not either worker. Do not edit files or read worker logs. For each lane independently: ${Object.entries(workers).map(([lane, worker]) => `read ${worker.contract}; inspect git -C ${worker.repo} diff main...ship/${lane}/code; run node --test ${worker.repo}/test/${lane}.test.mjs; independently import ${worker.repo}/src/${lane}.mjs and assert identity(2)=2, ${worker.action}(0)=0 and ${worker.action}(-2)=${-2 * worker.factor}`).join('; ')}. Return AGREE only if BOTH lanes meet acceptance and path scope. Return concise command/exit/evidence matrix. No credentials, network, commit, push, merge or deploy.\n`);
    const r = await run("omp", ["-p", "--model", model, "--auto-approve", "--no-session", "--max-time", "3m", "--cwd", sandbox, `@${brief}`], { cwd: sandbox, timeout: 210000 });
    await writeFile(join(sandbox, "verifier-result.txt"), r.stdout + r.stderr); assert.equal(r.code, 0, `Inspect ${sandbox}/verifier-result.txt`); assert.match(r.stdout, /\bAGREE\b/); assert.doesNotMatch(r.stdout, /\bDISAGREE\b/);
    for (const lane of ["A", "B"]) {
      assert.equal((await ship(`owner_${lane}`, "check", "--contract", `contract_${lane}`, "--slice", "code")).ok, true);
      await ship(`owner_${lane}`, "inbox", "add", "--type", "needs_review", "--title", `${lane} verified`, "--summary", "Independent verifier passed acceptance and scope; fixture awaits human review.", "--source-task-id", `task_${lane}`, "--contract", `contract_${lane}`, "--evidence", `fixture:verifier/${lane}`, "--lane", lane);
    }
    const status = await ship("captain", "status", "--brief"); assert.equal(status.pending_human, 2); assert.equal(status.pending_human_components.open_inbox, 2); assert.equal(status.pending_human_components.draft_proposals, 0);
    assert.equal((await ship("captain", "inbox", "list", "--lane", "A", "--json")).length, 1);
    return { runtime: "omp", model, verdict: "AGREE", pending_human: status.pending_human, final_acceptance: "pending; no user's acceptance impersonated" };
  });
  await pass("Executable host hook, captain-only local notification, human limits and lane-scoped stop", async () => {
    const hook = join(home, ".agent-ship-kit/current/scripts/host-pre-tool.mjs");
    await ship("captain", "captain", "heartbeat");
    const denied = join(sandbox, "denied.json"), allowed = join(sandbox, "allowed.json");
    await writeFile(denied, JSON.stringify({ tool: "shell", argv: ["git", "diff"] })); await writeFile(allowed, JSON.stringify({ tool: "shell", argv: ["agent-ship", "intake", "list"] }));
    async function hookRun(file) {
      return new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [hook, "--root", project], { env: { ...env, AGENT_SHIP_ACTOR: "captain" } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
        readFile(file).then(bytes => child.stdin.end(bytes), reject);
      });
    }
    assert.equal((await hookRun(denied)).code, 2); assert.equal((await hookRun(allowed)).code, 0);
    const sentinel = join(sandbox, "notification.txt"), script = join(sandbox, "notify.cjs");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], 'local fixture notification');");
    const action = `${process.execPath} ${script} ${sentinel}`, policy = join(sandbox, "policy.md"), allowlist = join(sandbox, "allow.json");
    await writeFile(policy, `## Rule: fixture\nwhen.type: needs_review\naction: ${action}\n`); await writeFile(allowlist, JSON.stringify({ patterns: [action] }));
    const args = ["notify", "run", "--root", project, "--latest", "--policy", policy, "--allowlist", allowlist];
    const owner = await run(cli, args, { env: { ...env, AGENT_SHIP_ACTOR: "owner_B" } }); assert.notEqual(owner.code, 0); assert.match(owner.stderr, /requires captain/); await assert.rejects(readFile(sentinel), /ENOENT/);
    const captain = await run(cli, args, { env: { ...env, AGENT_SHIP_ACTOR: "captain" } }); assert.equal(captain.code, 0, captain.stderr); assert.match(await readFile(sentinel, "utf8"), /fixture/);
    const deniedCap = await run(cli, ["limits", "set", "--root", project, "--global-max-parallel", "9", "--by", "fixture-human"], { env: { ...env, AGENT_SHIP_ACTOR: "owner_B" } }); assert.notEqual(deniedCap.code, 0);
    await ship("fixture-human", "limits", "set", "--global-max-parallel", "3", "--by", "fixture-human");
    const cross = await run(cli, ["slice", "update", "--root", project, "--lane", "A", "--source-task-id", "task_B", "--status", "cancelled"], { env: { ...env, AGENT_SHIP_ACTOR: "owner_A" } }); assert.notEqual(cross.code, 0);
    await ship("owner_B", "slice", "update", "--lane", "B", "--source-task-id", "task_B", "--status", "cancelled");
    await ship("captain", "intake", "update", "request_B", "--state", "dropped");
    const status = await ship("captain", "status", "--brief"); assert.equal(status.lanes.find(lane => lane.lane_id === "B").stage, "dropped"); assert.equal(status.lanes.find(lane => lane.lane_id === "A").stage, "needs_review");
    return { captain_git_hook_exit: 2, captain_intake_hook_exit: 0, owner_notify_exit: owner.code, captain_local_notify_exit: captain.code, owner_limits_exit: deniedCap.code, cross_lane_stop_exit: cross.code, lane_A: "needs_review", lane_B: "dropped", remote_messages_sent: 0 };
  });
  report.ok = true;
} catch (error) { report.error = error.stack ?? error.message; process.exitCode = 1; }
finally {
  if (cli) { const cleanup = await run(cli, ["watchdog", "uninstall", "--root", project], { env }); report.timer_cleanup_exit = cleanup.code; if (cleanup.code) { report.ok = false; process.exitCode = 1; } }
  report.finished_at = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2)); process.stdout.write(`Trial ${report.ok ? "passed" : "FAILED"}; report: ${reportFile}\n`); if (report.error) process.stderr.write(report.error + "\n");
}
