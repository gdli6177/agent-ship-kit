import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentCommand, codexArguments } from "../electron/agent-command.ts";

test("parses CLI commands, quoted arguments and absolute paths without a shell", () => {
  assert.deepEqual(parseAgentCommand('"/opt/Agent Tools/codex" --model "model name" -c reasoning_effort=high', ["codex", "omp"]), {
    executable: "/opt/Agent Tools/codex", kind: "codex",
    args: ["--model", "model name", "-c", "reasoning_effort=high"],
  });
  assert.deepEqual(parseAgentCommand("omp --model my-model", ["omp"]).args, ["--model", "my-model"]);
  for (const command of ["codex | tee log", "codex; echo hi", "codex $(pwd)", "codex\nls", 'codex --model "oops'])
    assert.throws(() => parseAgentCommand(command, ["codex"]));
  assert.throws(() => parseAgentCommand("FOO=bar codex", ["codex"]), /环境变量/);
  assert.throws(() => parseAgentCommand("unknown-agent --model x", ["codex"]), /暂不支持/);
});

test("preserves native model and explicit policy arguments", () => {
  const args = codexArguments(["--model", "my-model", "--sandbox=read-only", "-a", "on-request"], "/cli", ["/project"], "/bin");
  assert.ok(!args.includes("never"));
  assert.ok(!args.includes("workspace-write"));
  assert.deepEqual(args.slice(-5), ["--model", "my-model", "--sandbox=read-only", "-a", "on-request"]);
  assert.ok(codexArguments([], "/cli", [], "/bin").includes("workspace-write"));
  const automatic = codexArguments(["--full-auto"], "/cli", [], "/bin");
  assert.ok(automatic.includes("--full-auto"));
  // A native policy flag prevents a second, conflicting Crewvane default.
  assert.ok(!automatic.includes("workspace-write"));
});
