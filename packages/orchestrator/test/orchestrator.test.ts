import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorkspaceStore,
  type ExecutionProfile,
  type RuntimeAdapter,
  type SessionOptions,
  type StageResult,
  type Task,
  type WorkflowTemplate,
} from "../../core/src/index.js";
import { Orchestrator, WorkspaceService } from "../src/index.js";
import { git } from "../src/git.js";
const workflow: WorkflowTemplate = {
  id: "trial",
  name: "开发与独立回归",
  version: 1,
  stages: [
    {
      id: "develop",
      name: "开发",
      goal: "实现目标",
      role: "worker",
      inputs: ["request"],
      outputs: ["implementation"],
      completion: "行为符合需求",
      parallel: 1,
      retries: 0,
    },
    {
      id: "verify",
      name: "独立验证",
      goal: "重跑验收",
      role: "verifier",
      inputs: ["request", "implementation"],
      outputs: ["verification"],
      completion: "通过实际检查",
      parallel: 1,
      retries: 2,
      returnTo: "develop",
    },
  ],
};
async function fixture(
  fn: (root: string, service: WorkspaceService) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewvane-engine-")),
  );
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Trial");
    await git(root, "config", "user.email", "trial@example.com");
    await writeFile(join(root, ".gitignore"), ".crewvane/\n");
    await writeFile(join(root, "app.txt"), "baseline\n");
    await git(root, "add", ".gitignore", "app.txt");
    await git(root, "commit", "-m", "baseline");
    const service = new WorkspaceService(root);
    await service.store.update("fixture.runtime", (state) => {
      state.runtimes.push({
        id: "omp",
        name: "Protocol fixture",
        status: "ready",
        models: [{ id: "fixture", name: "fixture" }],
      });
    });
    await service.execute({
      type: "profile.save",
      profile: {
        id: "test",
        name: "Fixture profile",
        runtime: "omp",
        model: "fixture",
      },
    });
    await service.execute({
      type: "project.save",
      project: {
        id: "project",
        name: "Trial",
        path: root,
        baseBranch: "main",
        checks: [
          [
            process.execPath,
            "-e",
            "const fs=require('fs');if(!fs.readFileSync('app.txt','utf8').includes('implemented'))process.exit(1)",
          ],
        ],
        roles: {},
        defaultProfile: "test",
      },
    });
    await service.execute({
      type: "grant.save",
      projectId: "project",
      grant: {
        approvedBy: "test-human",
        profiles: ["test"],
        actions: ["read", "write", "verify"],
        allowedPaths: ["app.txt"],
        forbiddenPaths: ["AGENTS.md"],
        maxParallel: 3,
        maxTaskMinutes: 1,
      },
    });
    await service.execute({ type: "workflow.save", workflow });
    await fn(root, service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
class FixtureAdapter implements RuntimeAdapter {
  id = "omp" as const;
  active = 0;
  max = 0;
  opens: SessionOptions[] = [];
  verificationRounds = 0;
  constructor(
    readonly behavior: {
      rework?: boolean | "always";
      blocked?: boolean;
      human?: boolean;
      escape?: boolean;
      wait?: number;
    } = {},
  ) {}
  async probe() {
    return {
      id: this.id,
      name: "fixture",
      status: "ready" as const,
      models: [{ id: "fixture", name: "fixture" }],
    };
  }
  async open(options: SessionOptions) {
    this.opens.push(options);
    let cancelled = false;
    return {
      id: `fixture-${this.opens.length}`,
      pid: 0,
      models: [{ id: "fixture", name: "fixture" }],
      cancel: async () => {
        cancelled = true;
      },
      close: async () => {
        cancelled = true;
      },
      prompt: async (prompt: string) => {
        const role = options.role,
          outputKeys: string[] = JSON.parse(
            /必须输出字段：(\[[^\n]+\])/.exec(prompt)?.[1] ?? '["plan"]',
          );
        const result: StageResult = {
          status: "done",
          summary: "verified implementation",
          evidence: ["fixture check completed"],
          outputs: Object.fromEntries(
            outputKeys.map((k) => [k, "implemented artifact"]),
          ),
        };
        if (this.behavior.human && /直属下级的问题/.test(prompt))
          return JSON.stringify({
            ...result,
            status: "blocked",
            question: "Need product decision",
            summary: "Cannot resolve within grant",
          });
        if (role === "worker") {
          this.active++;
          this.max = Math.max(this.max, this.active);
          try {
            await delay(this.behavior.wait ?? 20);
            if (cancelled) throw new Error("cancelled fixture turn");
            if (this.behavior.blocked && !/上次结果/.test(prompt))
              return JSON.stringify({
                ...result,
                status: "blocked",
                question: "Which boundary should be used?",
                recommendation: "Use the existing project boundary",
              });
            await writeFile(
              join(
                options.cwd,
                this.behavior.escape ? "outside.txt" : "app.txt",
              ),
              "implemented\n",
            );
          } finally {
            this.active--;
          }
        }
        if (role === "verifier") {
          this.verificationRounds++;
          assert.match(
            await readFile(join(options.cwd, "app.txt"), "utf8"),
            /implemented/,
          );
          if (
            this.behavior.rework &&
            (this.behavior.rework === "always" || this.verificationRounds === 1)
          )
            result.status = "rework";
        }
        return JSON.stringify(result);
      },
    };
  }
}
async function submit(
  service: WorkspaceService,
  request = "Implement the local trial",
) {
  return service.execute({
    type: "task.submit",
    projectId: "project",
    request,
    workflowId: "trial",
  }) as Promise<Task>;
}
test("real Git worktrees, isolated agent sessions, verifier and host checks produce a local delivery", () =>
  fixture(async (root, service) => {
    const adapter = new FixtureAdapter(),
      engine = new Orchestrator(root, () => adapter),
      task = await submit(service);
    try {
      await engine.runUntilIdle();
      const state = await service.store.read(),
        done = state.tasks.find((t) => t.id === task.id)!;
      assert.equal(done.status, "completed", done.error);
      assert.equal(done.pr, undefined);
      assert.equal(await readFile(join(root, "app.txt"), "utf8"), "baseline\n");
      assert.match(
        await readFile(join(done.checkout!, "app.txt"), "utf8"),
        /implemented/,
      );
      assert.equal(done.reviewRounds, 1);
      assert.deepEqual(
        state.agents.map((a) => a.role),
        ["captain", "lead", "worker", "verifier"],
      );
      assert.ok(state.agents[1]!.parent);
      assert.ok(state.agents[2]!.parent);
      assert.match(
        await readFile(
          join(root, ".crewvane/evidence", task.id, "report.md"),
          "utf8",
        ),
        /Verified head/,
      );
    } finally {
      await engine.stop();
    }
  }));
test("five demands share capacity three; cancelling B preserves A and starts queued work", () =>
  fixture(async (root, service) => {
    const adapter = new FixtureAdapter({ wait: 180 }),
      engine = new Orchestrator(root, () => adapter);
    const tasks = await Promise.all(
      Array.from({ length: 5 }, (_, i) => submit(service, `Demand ${i}`)),
    );
    try {
      await engine.start();
      await engine.tick();
      for (let i = 0; i < 100; i++) {
        if (
          (await service.store.read()).agents.filter(
            (a) => a.role === "worker" && a.status === "running",
          ).length >= 2
        )
          break;
        await delay(20);
      }
      await service.execute({ type: "task.cancel", taskId: tasks[1]!.id });
      await engine.runUntilIdle();
      const state = await service.store.read();
      assert.equal(
        state.tasks.find((t) => t.id === tasks[1]!.id)!.status,
        "cancelled",
      );
      assert.ok(
        state.tasks
          .filter((t) => t.id !== tasks[1]!.id)
          .every((t) => t.status === "completed"),
        JSON.stringify(
          state.tasks.map((t) => ({ status: t.status, error: t.error })),
        ),
      );
      assert.ok(adapter.max <= 3);
      assert.ok(adapter.max >= 2);
    } finally {
      await engine.stop();
    }
  }));
test("a second scheduler is refused; restart marks interrupted work for reconciliation", () =>
  fixture(async (root, service) => {
    const first = new Orchestrator(root),
      second = new Orchestrator(root);
    await first.start();
    await assert.rejects(second.start(), /another scheduler/);
    await first.stop();
    const task = await submit(service);
    await service.store.update("interruption", (s) => {
      s.tasks.find((t) => t.id === task.id)!.status = "running";
    });
    try {
      await second.start();
      assert.equal(
        (await service.store.read()).tasks[0]!.status,
        "needs_reconcile",
      );
    } finally {
      await second.stop();
    }
  }));
test("rework invalidates downstream evidence and invokes a new independent verifier", () =>
  fixture(async (root, service) => {
    const adapter = new FixtureAdapter({ rework: true }),
      engine = new Orchestrator(root, () => adapter);
    await submit(service);
    try {
      await engine.runUntilIdle();
      const state = await service.store.read(),
        task = state.tasks[0]!;
      assert.equal(task.status, "completed", task.error);
      assert.equal(task.reviewRounds, 2);
      assert.equal(task.workflow.round, 1);
      assert.ok(task.workflow.results.some((r) => !r.valid));
      assert.equal(state.agents.filter((a) => a.role === "verifier").length, 2);
    } finally {
      await engine.stop();
    }
  }));
test("scope escapes fail before integration or publication", () =>
  fixture(async (root, service) => {
    const adapter = new FixtureAdapter({ escape: true }),
      engine = new Orchestrator(root, () => adapter);
    await submit(service);
    try {
      await engine.runUntilIdle();
      const task = (await service.store.read()).tasks[0]!;
      assert.equal(task.status, "failed");
      assert.match(task.error!, /outside delegated scope/);
      assert.equal(await readFile(join(root, "app.txt"), "utf8"), "baseline\n");
    } finally {
      await engine.stop();
    }
  }));
test("human grants cannot be silently rebound by editing profiles or project settings", () =>
  fixture(async (_root, service) => {
    await assert.rejects(
      service.execute({
        type: "profile.save",
        profile: {
          id: "test",
          name: "changed",
          runtime: "omp",
          model: "fixture",
        },
      }),
      /revoke/,
    );
    const project = (await service.store.read()).projects[0]!;
    await assert.rejects(
      service.execute({ type: "project.save", project }),
      /revoke/,
    );
    await service.execute({ type: "grant.revoke", projectId: "project" });
    await assert.rejects(submit(service), /current human/);
  }));

test("internal questions are resolved by the immediate parent without human attention", () =>
  fixture(async (root, service) => {
    const w = structuredClone(workflow);
    w.version = 2;
    w.stages[0]!.retries = 1;
    await service.execute({ type: "workflow.save", workflow: w });
    const adapter = new FixtureAdapter({ blocked: true }),
      engine = new Orchestrator(root, () => adapter);
    await submit(service);
    try {
      await engine.runUntilIdle();
      const state = await service.store.read();
      assert.equal(state.tasks[0]!.status, "completed", state.tasks[0]!.error);
      assert.ok(
        state.decisions.some(
          (d) => d.level === "lead" && d.status === "resolved",
        ),
      );
      assert.equal(
        state.decisions.filter((d) => d.level === "human").length,
        0,
      );
    } finally {
      await engine.stop();
    }
  }));
test("only captain-unresolved questions reach humans; remembered answers prevent repeated escalation", () =>
  fixture(async (root, service) => {
    const w = structuredClone(workflow);
    w.version = 2;
    w.stages[0]!.retries = 1;
    await service.execute({ type: "workflow.save", workflow: w });
    const adapter = new FixtureAdapter({ blocked: true, human: true }),
      engine = new Orchestrator(root, () => adapter);
    await submit(service);
    try {
      await engine.runUntilIdle();
      let state = await service.store.read();
      const question = state.decisions.find((d) => d.level === "human")!;
      assert.ok(question);
      assert.equal(question.tried.length, 4);
      assert.equal(state.tasks[0]!.status, "waiting_human");
      await service.execute({
        type: "decision.answer",
        decisionId: question.id,
        answer: "Use the approved project boundary.",
        by: "test-human",
        remember: true,
      });
      await engine.runUntilIdle();
      assert.equal((await service.store.read()).tasks[0]!.status, "completed");
      await submit(service, "Second independent task with the same question");
      await engine.runUntilIdle();
      state = await service.store.read();
      assert.equal(state.tasks[1]!.status, "completed", state.tasks[1]!.error);
      assert.equal(
        state.decisions.filter((d) => d.level === "human").length,
        1,
      );
    } finally {
      await engine.stop();
    }
  }));
test("a fourth verification round is never started and the captain escalates the exhausted budget", () =>
  fixture(async (root, service) => {
    const adapter = new FixtureAdapter({ rework: "always" }),
      engine = new Orchestrator(root, () => adapter);
    await submit(service);
    try {
      await engine.runUntilIdle();
      const state = await service.store.read();
      assert.equal(state.tasks[0]!.status, "waiting_human");
      assert.equal(state.tasks[0]!.reviewRounds, 3);
      assert.equal(state.agents.filter((a) => a.role === "verifier").length, 3);
      assert.equal(
        state.decisions.filter(
          (d) => d.level === "human" && d.status === "open",
        ).length,
        1,
      );
    } finally {
      await engine.stop();
    }
  }));
test("discussion produces a plan without starting workers, then explicit retry authorizes execution", () =>
  fixture(async (root, service) => {
    const adapter = new FixtureAdapter(),
      engine = new Orchestrator(root, () => adapter);
    const task = (await service.execute({
      type: "task.submit",
      projectId: "project",
      request: "Discuss before implementing",
      workflowId: "trial",
      discussion: true,
    })) as Task;
    try {
      await engine.runUntilIdle();
      let state = await service.store.read();
      assert.equal(state.tasks[0]!.status, "waiting_human");
      assert.equal(
        state.agents.some((a) => a.role === "worker"),
        false,
      );
      await service.execute({ type: "task.retry", taskId: task.id });
      await engine.runUntilIdle();
      state = await service.store.read();
      assert.equal(state.tasks[0]!.status, "completed", state.tasks[0]!.error);
    } finally {
      await engine.stop();
    }
  }));

test("publication pushes only the verified branch and recovers the existing PR without duplicate creation", () =>
  fixture(async (root, service) => {
    const { publishPR } = await import("../src/git.js");
    const { chmod } = await import("node:fs/promises");
    const engine = new Orchestrator(root, () => new FixtureAdapter());
    await submit(service);
    const previousPath = process.env.PATH;
    try {
      await engine.runUntilIdle();
      const state = await service.store.read(),
        task = state.tasks[0]!,
        project = state.projects[0]!;
      project.grant!.actions.push("publish_pr");
      const remote = join(root, ".crewvane/remote.git"),
        bin = join(root, ".crewvane/bin"),
        receipt = join(root, ".crewvane/forge.json"),
        calls = join(root, ".crewvane/forge-calls.txt");
      await git(root, "init", "--bare", remote);
      await git(root, "remote", "add", "origin", remote);
      await mkdir(bin);
      const program = `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(calls)},process.argv.slice(2).join(' ')+'\\n');if(process.argv[3]==='list'){console.log(fs.existsSync(${JSON.stringify(receipt)})?fs.readFileSync(${JSON.stringify(receipt)},'utf8'):'[]')}else if(process.argv[3]==='create'){const pr={url:'https://github.com/fixture/repo/pull/1',headRefOid:${JSON.stringify(task.integrationHead)},state:'OPEN'};fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify([pr]));console.log(pr.url)}else process.exit(1);`;
      await writeFile(join(bin, "gh"), program);
      await chmod(join(bin, "gh"), 0o755);
      process.env.PATH = `${bin}:${previousPath}`;
      const first = await publishPR(project, task, "Verified report"),
        second = await publishPR(project, task, "Verified report");
      assert.equal(first, second);
      assert.equal(
        (await readFile(calls, "utf8"))
          .split("\n")
          .filter((line) => line.startsWith("pr create")).length,
        1,
      );
      assert.equal(
        await git(remote, "rev-parse", `refs/heads/${task.branch}`),
        task.integrationHead,
      );
    } finally {
      process.env.PATH = previousPath;
      await engine.stop();
    }
  }));

class ConversationAdapter extends FixtureAdapter {
  routePrompts: string[] = [];
  workerPrompts: string[] = [];
  constructor(readonly route: (message: import('../../core/src/index.js').ChatMessage) => import('../src/routing.js').CaptainRoute, wait = 20) {
    super({ wait });
  }
  override async open(options: SessionOptions) {
    const base = await super.open(options);
    return { ...base, prompt: async (prompt: string) => {
      const current = /当前消息：([^\n]+)/.exec(prompt);
      if (current) {
        this.routePrompts.push(prompt);
        return JSON.stringify({ status: 'done', summary: 'routing decision', evidence: ['conversation'],
          outputs: { routing: JSON.stringify(this.route(JSON.parse(current[1]!))) } });
      }
      if (options.role === 'worker') this.workerPrompts.push(prompt);
      return base.prompt(prompt);
    } };
  }
}

test('captain conversation switches A/B, creates new goals and queries status without forwarding the question', () => fixture(async (root, service) => {
  const a = await service.execute({ type: 'task.submit', projectId: 'project', request: 'Goal A', workflowId: 'trial', discussion: true }) as Task;
  const adapter = new ConversationAdapter(message => message.text === 'Create B'
    ? { action: 'create', workflowId: 'trial', request: 'Goal B', discussion: true, reply: 'B is now a separate goal' }
    : message.text === '补充A：保留旧行为'
      ? { action: 'forward', taskId: a.id, reply: '交给 A 队长' }
      : { action: 'status', taskId: a.id, reply: 'this model text must not be used as progress evidence' });
  const engine = new Orchestrator(root, () => adapter);
  try {
    await engine.runUntilIdle();
    await service.execute({ type: 'chat.send', projectId: 'project', taskId: a.id, text: 'Create B' });
    await service.execute({ type: 'chat.send', projectId: 'project', text: '补充A：保留旧行为' });
    await service.execute({ type: 'chat.send', projectId: 'project', text: 'A做到哪了' });
    await engine.runUntilIdle();
    const state = await service.store.read();
    assert.equal(state.tasks.length, 2);
    const b = state.tasks.find(t => t.id !== a.id)!;
    assert.equal(b.request, 'Goal B');
    assert.equal(state.tasks.find(t => t.id === a.id)!.contextRevision, 1);
    assert.equal(b.contextRevision, undefined);
    assert.equal(state.agents.filter(a => a.role === 'worker').length, 0);
    const messages = state.messages.filter(m => m.role === 'human' && m.routing);
    assert.deepEqual(messages.map(m => m.routing!.action), ['create', 'forward', 'status']);
    assert.equal(messages[0]!.contextTaskId, a.id);
    assert.equal(messages[0]!.taskId, b.id);
    const progress = state.messages.find(m => m.replyTo === messages[2]!.id)!.text;
    assert.match(progress, /Goal A：(等待你的决定|规划中|排队中)/);
    assert.ok(!progress.includes('this model text'));
    assert.ok(adapter.routePrompts[2]!.includes('Create B'), 'captain sees earlier turns across goals');
  } finally { await engine.stop(); }
}));

test('ambiguous messages survive restart, launch no workers, and a chosen target resolves the original question once', () => fixture(async (root, service) => {
  const a = await service.execute({ type: 'task.submit', projectId: 'project', request: 'A plan', workflowId: 'trial', discussion: true }) as Task;
  const adapter = new ConversationAdapter(() => ({ action: 'clarify', reply: '这条补充属于 A，还是新目标？', candidates: [a.id] }));
  let engine = new Orchestrator(root, () => adapter);
  await engine.runUntilIdle();
  const message = await service.execute({ type: 'chat.send', projectId: 'project', text: '原消息：需要额外边界测试' }) as import('../../core/src/index.js').ChatMessage;
  await engine.runUntilIdle();
  await engine.stop();
  assert.equal((await service.store.read()).messages.find(m => m.id === message.id)!.routing!.status, 'clarifying');
  assert.equal((await service.store.read()).agents.some(a => a.role === 'worker'), false);
  engine = new Orchestrator(root, () => adapter);
  try {
    await service.execute({ type: 'chat.send', projectId: 'project', clarifies: message.id, targetTaskId: a.id, text: '是A的补充' });
    await engine.runUntilIdle();
    const state = await service.store.read();
    const original = state.messages.find(m => m.id === message.id)!;
    assert.ok(original.routing!.resolvedBy);
    assert.equal(original.taskId, a.id);
    assert.equal(state.tasks[0]!.contextRevision, 1);
    await engine.runUntilIdle();
    assert.equal((await service.store.read()).tasks[0]!.contextRevision, 1);
    await assert.rejects(service.execute({ type: 'chat.send', projectId: 'project', clarifies: message.id, text: 'duplicate answer' }), /already resolved/);
  } finally { await engine.stop(); }
}));

test('routing is atomic, idempotent and cannot target another project or reuse revoked authorization', () => fixture(async (_root, service) => {
  const { applyCaptainRoute, parseCaptainRoute } = await import('../src/routing.js');
  const m = await service.execute({ type: 'chat.send', projectId: 'project', text: 'Create a new goal' }) as import('../../core/src/index.js').ChatMessage;
  const state = await service.store.read();
  const grantId = state.projects[0]!.grant!.id;
  const route = { action: 'create' as const, workflowId: 'trial', request: m.text, discussion: true, reply: '已创建' };
  applyCaptainRoute(state, m.id, route, grantId);
  applyCaptainRoute(state, m.id, route, grantId);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.messages.filter(msg => msg.replyTo === m.id).length, 1);
  assert.throws(() => parseCaptainRoute(JSON.stringify({ ...route, actions: ['publish_pr'] })), /invalid/);
  const fresh = await service.store.read();
  assert.throws(() => applyCaptainRoute(fresh, m.id, { action: 'forward', taskId: 'foreign', reply: 'x' }, grantId), /project/);
  assert.equal(fresh.tasks.length, 0);
  await service.execute({ type: 'grant.revoke', projectId: 'project' });
  assert.throws(() => applyCaptainRoute(fresh, m.id, route, 'stale-grant'), /authorization/);
}));

test('information arriving during a worker run is delivered only to its goal and forces fresh independent verification', () => fixture(async (root, service) => {
  const task = await submit(service);
  const adapter = new ConversationAdapter(() => ({ action: 'forward', taskId: task.id, reply: 'forwarded' }), 700);
  const engine = new Orchestrator(root, () => adapter);
  try {
    await engine.start();
    const running = engine.runUntilIdle();
    const deadline = Date.now() + 10_000;
    while (!adapter.workerPrompts.length && Date.now() < deadline) await delay(10);
    assert.equal(adapter.workerPrompts.length, 1);
    await service.execute({ type: 'chat.send', projectId: 'project', text: 'NEW_BOUNDARY_CASE 必须保留旧行为' });
    await running;
    const state = await service.store.read();
    assert.equal(state.tasks[0]!.status, 'completed', state.tasks[0]!.error);
    assert.equal(state.tasks[0]!.contextRevision, 1);
    assert.equal(state.tasks[0]!.executedRevision, 1);
    assert.ok(adapter.workerPrompts.length >= 2);
    assert.ok(adapter.workerPrompts.at(-1)!.includes('NEW_BOUNDARY_CASE'));
    assert.ok(!adapter.workerPrompts[0]!.includes('NEW_BOUNDARY_CASE'));
  } finally { await engine.stop(); }
}));

test('desktop knowledge uses existing CLI cards, injects rules, promotes only after review, and excludes expired lessons', () => fixture(async (root, service) => {
  const { knowledgeContext, persistLearning } = await import('../src/knowledge.js');
  await writeFile(join(root, 'TEAM.md'), '# Team rules\nBoundary tests must include zero.\n');
  await service.execute({ type: 'knowledge.configure', projectId: 'project', config: { handbook: 'TEAM.md', rules: [] } });
  const project = (await service.store.read()).projects[0]!;
  const initial = await knowledgeContext(project, 'boundary');
  assert.ok(initial.sources.some(s => s.bodyIncluded && s.body?.includes('include zero')));
  const task = { id: 'task_knowledge', integrationHead: 'a'.repeat(40) } as Task;
  const proposal = JSON.stringify({ outcome: 'candidate', reason: 'Prevents boundary regressions', title: 'Boundary checks', summary: 'Use real boundary assertions', when: 'When adding input boundaries', action: 'Test zero and negative inputs against the real file', tags: ['boundary'] });
  const result = await persistLearning(project, task, proposal, 'independent-author');
  assert.equal((await knowledgeContext(project, 'boundary')).lessons.length, 0);
  let library = await service.execute({ type: 'knowledge.list', projectId: 'project', query: 'boundary' }) as Awaited<ReturnType<typeof import('../src/knowledge.js').knowledgeLibrary>>;
  assert.equal(library.cards.length, 1);
  assert.equal(library.cards[0]!.auto, true);
  await assert.rejects(service.execute({ type: 'knowledge.review', projectId: 'project', lessonId: result.lessonIds[0]!, status: 'active', by: 'independent-author', note: 'Self review denied' }), /author and reviewer/);
  await service.execute({ type: 'knowledge.review', projectId: 'project', lessonId: result.lessonIds[0]!, status: 'active', by: 'test-human', note: 'Checked evidence and applicability' });
  const { teamContext } = await import('../../../cli/src/learning.js');
  assert.equal((await teamContext(root, { project: 'project', auto: true })).lessons[0]!.id, result.lessonIds[0]);
  assert.equal((await knowledgeContext(project, 'boundary')).lessons[0]!.id, result.lessonIds[0]);
  await service.execute({ type: 'knowledge.review', projectId: 'project', lessonId: result.lessonIds[0]!, status: 'retired', by: 'test-human', note: 'Superseded by project change' });
  assert.equal((await knowledgeContext(project, 'boundary')).lessons.length, 0);
  assert.equal(await readFile(join(root, 'TEAM.md'), 'utf8'), '# Team rules\nBoundary tests must include zero.\n');
  await assert.rejects(service.execute({ type: 'knowledge.configure', projectId: 'project', config: { handbook: '.env', rules: [] } }), /unsafe/);
}));

test('verified delivery extracts a candidate and a later worker can query the reviewed knowledge in the same session', () => fixture(async (root, service) => {
  await service.execute({ type: 'knowledge.configure', projectId: 'project', config: { handbook: null, rules: [] } });
  let queried = false;
  let received = false;
  const adapter = new FixtureAdapter();
  const open = adapter.open.bind(adapter);
  adapter.open = async options => {
    const session = await open(options);
    let original = '';
    let asked = false;
    return { ...session, prompt: async prompt => {
      if (prompt.includes('本轮只从已经完成')) return JSON.stringify({ status: 'done', summary: 'Reusable learning identified', evidence: ['verified branch'], outputs: { learning: JSON.stringify({ outcome: 'candidate', reason: 'Actual file checks are reusable', title: 'Boundary tests', summary: 'Use real files', when: 'Boundary file changes', action: 'Read the file from disk and assert its exact bytes', tags: ['boundary'] }) } });
      if (options.role === 'worker' && queried && !asked) {
        original = prompt; asked = true;
        return JSON.stringify({ status: 'blocked', summary: 'Need team knowledge', question: 'How to check boundaries?', knowledgeQuery: 'boundary', evidence: [], outputs: {} });
      }
      if (prompt.startsWith('查询结果：')) {
        received = prompt.includes('Read the file from disk');
        return session.prompt(original + '\n' + prompt);
      }
      return session.prompt(prompt);
    } };
  };
  const engine = new Orchestrator(root, () => adapter);
  try {
    await submit(service, 'First boundary goal');
    await engine.runUntilIdle();
    let state = await service.store.read();
    assert.equal(state.tasks[0]!.status, 'completed', state.tasks[0]!.error);
    assert.equal(state.tasks[0]!.learning?.outcome, 'candidate', state.tasks[0]!.learning?.reason);
    const id = state.tasks[0]!.learning!.lessonIds[0]!;
    await service.execute({ type: 'knowledge.review', projectId: 'project', lessonId: id, status: 'active', by: 'test-human', note: 'Verified actual task evidence' });
    queried = true;
    await submit(service, 'Second boundary goal');
    await engine.runUntilIdle();
    state = await service.store.read();
    assert.equal(state.tasks[1]!.status, 'completed', state.tasks[1]!.error);
    assert.ok(received);
    assert.ok(state.agents.some(a => a.role === 'worker' && a.taskId === state.tasks[1]!.id && a.lessonIds?.includes(id)));
  } finally { await engine.stop(); }
}));

test('secure references inject only the authorized host check, redact split output, and never reach agents or events', () => fixture(async (root, service) => {
  const { CredentialVault } = await import('../src/credentials.js');
  const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto');
  const secret = 'synthetic-only-' + randomBytes(16).toString('hex');
  const key = randomBytes(32);
  const vault = new CredentialVault(join(root, 'vault'), {
    available: async () => true,
    encrypt: async text => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decrypt: async data => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(); },
  });
  await service.execute({ type: 'grant.revoke', projectId: 'project' });
  let project = (await service.store.read()).projects[0]!;
  const { grant: oldGrant, shipPolicy, ...settings } = project;
  settings.checks = [[process.execPath, '-e', "const v=process.env.E2E_PASSWORD;if(!v)process.exit(1);process.stdout.write(v.slice(0,8));setTimeout(()=>process.stdout.write(v.slice(8)),5)"]];
  await service.execute({ type: 'project.save', project: settings });
  project = (await service.store.read()).projects[0]!;
  const reference = await vault.save(project, { label: 'Test password', env: 'E2E_PASSWORD', checkIndex: 0, value: secret });
  await service.execute({ type: 'credential.register', projectId: project.id, reference });
  await assert.rejects(service.execute({ type: 'credential.register', projectId: project.id, reference: { ...reference, value: secret } as typeof reference }), /invalid/);
  await service.execute({ type: 'grant.save', projectId: project.id, grant: {
    approvedBy: 'test-human', profiles: ['test'], actions: ['read', 'write', 'verify'],
    allowedPaths: ['app.txt'], forbiddenPaths: ['AGENTS.md'], maxParallel: 3, maxTaskMinutes: 1, credentials: [reference.id],
  } });
  project = (await service.store.read()).projects[0]!;
  const wrongCheck = await vault.environment(project, 1);
  assert.deepEqual(wrongCheck.env, {});
  assert.equal((await readFile(join(root, 'vault', `${reference.id}.json`), 'utf8')).includes(secret), false);
  const adapter = new ConversationAdapter(() => ({ action: 'reply', reply: 'test' }));
  const baseOpen = adapter.open.bind(adapter);
  let verifierReceivedRedaction = false;
  let verificationHead = '';
  adapter.open = async options => {
    if (options.role === 'verifier') {
      const { git } = await import('../src/git.js');
      verificationHead = await git(options.cwd, 'rev-parse', 'HEAD');
    }
    const session = await baseOpen(options);
    let original = '';
    return { ...session, prompt: async prompt => {
      if (options.role === 'verifier' && !original) {
        original = prompt;
        return JSON.stringify({ status: 'blocked', question: 'Run the credential check through the host', summary: 'Host verification required', verifyCheck: 0, evidence: [], outputs: {} });
      }
      if (options.role === 'verifier' && prompt.startsWith('宿主实际验证结果')) {
        verifierReceivedRedaction = prompt.includes('[redacted]') && !prompt.includes(secret);
        return session.prompt(original + '\n' + prompt);
      }
      return session.prompt(prompt);
    } };
  };
  const engine = new Orchestrator(root, () => adapter, {
    testEnvironment: async (_taskId, checkIndex) => vault.environment((await service.store.read()).projects[0]!, checkIndex),
  });
  try {
    const task = await submit(service);
    await engine.runUntilIdle();
    const state = await service.store.read();
    assert.equal(state.tasks[0]!.status, 'completed', state.tasks[0]!.error);
    const report = await readFile(join(root, '.crewvane/evidence', task.id, 'report.md'), 'utf8');
    assert.ok(report.includes('[redacted]'));
    assert.ok(!report.includes(secret));
    assert.ok(!JSON.stringify(state).includes(secret));
    assert.ok(!adapter.workerPrompts.join('').includes(secret));
    assert.equal(state.credentialAccess?.[0]!.credentialIds[0], reference.id);
    assert.equal(state.credentialAccess?.length, 1);
    assert.ok(state.agents.some(a => a.role === 'verifier' && a.hostChecks?.head === verificationHead && a.hostChecks.checks[0]?.index === 0 && a.hostChecks.checks[0].output.includes('[redacted]')));
    assert.ok(verifierReceivedRedaction);
    await assert.rejects(service.execute({ type: 'credential.remove', projectId: project.id, credentialId: reference.id }), /revoke/);
    await assert.rejects(vault.environment({ ...project, credentials: [{ ...reference, env: 'E2E_OTHER' }] }, 0), /differs/);
    await service.execute({ type: 'grant.revoke', projectId: project.id });
    await assert.rejects(vault.environment((await service.store.read()).projects[0]!, 0), /current human/);
  } finally { await engine.stop(); }
}));
