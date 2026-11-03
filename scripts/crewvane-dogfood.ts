import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Orchestrator,
  WorkspaceService,
} from "../packages/orchestrator/src/index.js";
import { command, git } from "../packages/orchestrator/src/git.js";
import type { ExecutionProfile, Task } from "../packages/core/src/index.js";
const resumeRoot = process.argv[2];
const root = await realpath(
  resumeRoot ?? (await mkdtemp(join(tmpdir(), "crewvane-dogfood-"))),
);
let infos: any[] = [];
const profiles: ExecutionProfile[] = [];
const service = new WorkspaceService(root),
  engine = new Orchestrator(root);
const startedAt = new Date().toISOString();
console.log(JSON.stringify({ root, startedAt }));
if (!resumeRoot) {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Crewvane Trial");
  await git(root, "config", "user.email", "trial@crewvane.local");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, ".gitignore"), ".crewvane/\n");
  await writeFile(
    join(root, "AGENTS.md"),
    "# Isolated Crewvane trial\nWrite only the task's named src/item-N.txt and test/item-N.test.cjs. Read this file. Do not read credentials or anything outside this checkout. Do not create subagents, publish, merge, deploy or install dependencies. Use your runtime's normal file and process tools; read-only shell inspection is allowed. The host commits. For verification run exactly node --test with no extra arguments and no other commands. Return real evidence in the requested StageResult JSON.\n",
  );
  await writeFile(join(root, "src/.gitkeep"), "");
  await writeFile(
    join(root, "test/baseline.test.cjs"),
    "const {test}=require('node:test');const assert=require('node:assert/strict');test('baseline',()=>assert.equal(1+1,2));\n",
  );
  await git(
    root,
    "add",
    ".gitignore",
    "AGENTS.md",
    "src/.gitkeep",
    "test/baseline.test.cjs",
  );
  await git(root, "commit", "-m", "trial baseline");
  infos = (await service.execute({ type: "scan", probe: "all" })) as any[];
  console.log(
    JSON.stringify({
      runtimes: infos.map((i) => ({
        id: i.id,
        status: i.status,
        version: i.version,
        models: i.models.length,
        reason: i.reason,
      })),
    }),
  );
  const preferred = [
    [
      "omp",
      [
        "minimax-code-cn/MiniMax-M3.1-Flash",
        "google-antigravity/gemini-3.8-flash",
        "magpie/codex/gpt-6.1-sol",
      ],
    ],
    ["codex", ["group/group", "gpt-6.1-sol"]],
    [
      "dsh",
      [
        '["magpie","opencode-go/minimax-m3.1-flash"]',
        '["magpie-responses","codex/gpt-6.1-sol"]',
      ],
    ],
  ] as const;
  for (const [runtime, candidates] of preferred) {
    const info = infos.find((item) => item.id === runtime);
    const model = candidates.find((candidate) =>
      info?.models.some((item: { id: string }) => item.id === candidate),
    );
    if (info?.status === "ready" && model)
      profiles.push({
        id: `${runtime}-real`,
        name: `${info.name} real`,
        runtime,
        model,
        effort: "high",
      });
  }
  if (profiles.length < 2)
    throw new Error(
      `real trial needs at least two ready runtimes with a verified model; available: ${infos
        .map((item) => `${item.id}:${item.status}:${item.models.length}`)
        .join(", ")}`,
    );
  console.log(
    JSON.stringify({
      trialProfiles: profiles.map((profile) => ({
        runtime: profile.runtime,
        model: profile.model,
      })),
    }),
  );
  for (const profile of profiles)
    await service.execute({ type: "profile.save", profile });
  await service.execute({
    type: "project.save",
    project: {
      id: "trial",
      name: "Real runtime trial",
      path: root,
      baseBranch: "main",
      checks: [["node", "--test"]],
      roles: {},
      defaultProfile: profiles[0]!.id,
    },
  });
  await service.execute({
    type: "grant.save",
    projectId: "trial",
    grant: {
      approvedBy: "authorized-product-dogfood",
      actions: ["read", "write", "verify"],
      profiles: profiles.map((p) => p.id),
      allowedPaths: ["src/**", "test/**"],
      forbiddenPaths: ["AGENTS.md", ".gitignore"],
      maxParallel: 3,
      maxTaskMinutes: 5,
    },
  });
}
const tasks: Task[] = [];
if (resumeRoot) {
  const state = await service.store.read();
  infos = state.runtimes;
  profiles.push(...state.profiles);
  tasks.push(
    ...state.tasks.filter((task) => /^本地验收需求 [0-4]：/.test(task.request)),
  );
  for (const task of tasks)
    if (["failed", "needs_reconcile"].includes(task.status))
      await service.execute({ type: "task.retry", taskId: task.id });
} else {
  for (let i = 0; i < 5; i++)
    tasks.push(
      (await service.execute({
        type: "task.submit",
        projectId: "trial",
        request: `本地验收需求 ${i}：创建 src/item-${i}.txt，内容必须是 crewvane verified ${i} 加换行；创建 test/item-${i}.test.cjs，使用 Node 内置 test 和 assert 实际读取这个文件并断言内容。不要修改其他文件，不使用第三方依赖。设计阶段只输出设计文字；开发阶段可使用运行时正常的文件与进程工具，只读检查时允许 shell。验证时只运行 node --test，不附加参数或其他命令。最终交付仅本地分支，不发布。`,
        workflowId: "feature",
        profile: profiles[i % profiles.length]!.id,
      })) as Task,
    );
}
let maxWorkers = 0;
const permissionEvents: unknown[] = [];
engine.on("permission", (event) => {
  permissionEvents.push(event);
  console.log(JSON.stringify({ permission: event }));
});
engine.on("diagnostic", (message) =>
  console.log(JSON.stringify({ diagnostic: message })),
);
engine.on("runtime", (event) => {
  if (event.type === "permission")
    console.log(JSON.stringify({ permissionDetail: event }));
});
let last = "";
const progress = setInterval(async () => {
  const state = await service.store.read();
  maxWorkers = Math.max(
    maxWorkers,
    state.agents.filter(
      (a) =>
        ["worker", "verifier"].includes(a.role) &&
        ["running", "reserved"].includes(a.status),
    ).length,
  );
  const snapshot = state.tasks.map((t) => ({
    id: t.id,
    status: t.status,
    stage: t.workflow.stage,
    error: t.error,
    summary: t.summary,
  }));
  const encoded = JSON.stringify(snapshot);
  if (encoded !== last) {
    console.log(encoded);
    last = encoded;
  }
}, 1500);
try {
  await engine.runUntilIdle(20 * 60_000);
  const state = await service.store.read();
  const report = {
    root,
    startedAt,
    finishedAt: new Date().toISOString(),
    maxWorkers,
    runtimes: infos.map((i) => ({
      id: i.id,
      version: i.version,
      status: i.status,
    })),
    tasks: state.tasks,
    agents: state.agents,
    decisions: state.decisions,
    permissionEvents,
    executedRuntimes: [
      ...new Set(
        state.agents
          .filter((agent) => agent.status === "completed")
          .map((agent) => `${agent.runtime}:${agent.model}`),
      ),
    ],
  };
  await writeFile(
    join(root, "trial-report.json"),
    JSON.stringify(report, null, 2),
  );
  for (let i = 0; i < tasks.length; i++) {
    const task = state.tasks.find((t) => t.id === tasks[i]!.id)!;
    assert.equal(
      task.status,
      "completed",
      `${task.title}: ${task.error ?? task.summary}`,
    );
    assert.equal(
      await readFile(join(task.checkout!, `src/item-${i}.txt`), "utf8"),
      `crewvane verified ${i}\n`,
    );
    await command(["node", "--test"], task.checkout!);
  }
  assert.ok(maxWorkers <= 3);
  assert.ok(maxWorkers >= 2);
  console.log(
    JSON.stringify({ ok: true, report: join(root, "trial-report.json") }),
  );
} finally {
  clearInterval(progress);
  await engine.stop();
}
