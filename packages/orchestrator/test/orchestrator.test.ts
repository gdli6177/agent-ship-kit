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
