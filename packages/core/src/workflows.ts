import type {
  ExecutionProfile,
  WorkflowTemplate,
  WorkspaceState,
} from "./types.js";
export const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid id");
}
export function validateWorkflow(
  value: WorkflowTemplate,
  profiles: ExecutionProfile[],
): void {
  assertId(value.id);
  if (
    !value.name?.trim() ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.stages) ||
    value.stages.length < 2 ||
    value.stages.length > 20
  )
    throw new Error("invalid workflow template");
  const seen = new Set<string>(),
    outputs = new Set<string>(["request"]);
  let verifier = false;
  for (const [i, stage] of value.stages.entries()) {
    assertId(stage.id);
    if (
      seen.has(stage.id) ||
      !stage.name?.trim() ||
      !stage.goal?.trim() ||
      !stage.completion?.trim() ||
      !["worker", "verifier"].includes(stage.role)
    )
      throw new Error("invalid workflow stage");
    if (
      !Number.isInteger(stage.parallel) ||
      stage.parallel < 1 ||
      stage.parallel > 8 ||
      !Number.isInteger(stage.retries) ||
      stage.retries < 0 ||
      stage.retries > 3
    )
      throw new Error("invalid stage budget");
    if (stage.role === "verifier" && stage.parallel !== 1)
      throw new Error("verification requires one independent verifier");
    if (stage.profile && !profiles.some((p) => p.id === stage.profile))
      throw new Error(`unknown profile: ${stage.profile}`);
    if (
      !Array.isArray(stage.inputs) ||
      stage.inputs.some((input) => !outputs.has(input))
    )
      throw new Error(`unresolved inputs in ${stage.id}`);
    if (!Array.isArray(stage.outputs) || !stage.outputs.length)
      throw new Error("stage outputs required");
    for (const output of stage.outputs) {
      assertId(output);
      if (outputs.has(output)) throw new Error(`duplicate output ${output}`);
      outputs.add(output);
    }
    if (
      stage.returnTo &&
      (!seen.has(stage.returnTo) || stage.role !== "verifier")
    )
      throw new Error("returnTo must name a previous stage on verification");
    if (stage.role === "verifier") {
      verifier = true;
      if (i !== value.stages.length - 1)
        throw new Error("verification must be the last stage before delivery");
    }
    seen.add(stage.id);
  }
  if (!verifier) throw new Error("independent verification required");
}
export function builtinWorkflows(): WorkflowTemplate[] {
  return [
    {
      id: "feature",
      name: "功能开发",
      version: 1,
      stages: [
        {
          id: "design",
          name: "设计",
          role: "worker",
          goal: "调查项目，形成实现设计与验收清单。",
          inputs: ["request"],
          outputs: ["design"],
          completion: "明确行为、范围和测试，不修改产品源代码。",
          parallel: 1,
          retries: 1,
        },
        {
          id: "develop",
          name: "开发",
          role: "worker",
          goal: "按设计实现需求，补齐有意义的测试。",
          inputs: ["request", "design"],
          outputs: ["implementation"],
          completion: "实现可运行，提交源代码，解释验证结果。",
          parallel: 1,
          retries: 2,
        },
        {
          id: "verify",
          name: "独立测试",
          role: "verifier",
          goal: "独立重跑验收，仅报告导致错误的问题，不报告风格偏好。",
          inputs: ["request", "design", "implementation"],
          outputs: ["verification"],
          completion: "只读检查完整集成分支，返回 done 或 rework。",
          parallel: 1,
          returnTo: "develop",
          retries: 2,
        },
      ],
    },
    {
      id: "bugfix",
      name: "缺陷修复",
      version: 1,
      stages: [
        {
          id: "reproduce",
          name: "复现与定位",
          role: "worker",
          goal: "真实复现问题，说明触发条件和根因。",
          inputs: ["request"],
          outputs: ["reproduction"],
          completion: "给出可复核步骤与失败证据。",
          parallel: 1,
          retries: 1,
        },
        {
          id: "fix",
          name: "修复",
          role: "worker",
          goal: "修复根因，增加防止复发的回归测试。",
          inputs: ["request", "reproduction"],
          outputs: ["fix"],
          completion: "原复现通过，相关测试通过。",
          parallel: 1,
          retries: 2,
        },
        {
          id: "verify",
          name: "独立回归",
          role: "verifier",
          goal: "独立重跑复现和回归，检查实际结果。",
          inputs: ["request", "reproduction", "fix"],
          outputs: ["verification"],
          completion: "只读检查，所有验收通过才 done。",
          parallel: 1,
          returnTo: "fix",
          retries: 2,
        },
      ],
    },
  ];
}
export function initialState(): WorkspaceState {
  return {
    version: 1,
    profiles: [],
    runtimes: [],
    projects: [],
    workflows: builtinWorkflows(),
    tasks: [],
    agents: [],
    decisions: [],
    ledger: [],
    messages: [],
    maxParallel: 3,
  };
}
