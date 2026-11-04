import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentCommand } from "../electron/agent-command.ts";

test("parses CLI commands, quoted arguments and absolute paths without a shell", () => {
  assert.deepEqual(parseAgentCommand('"/opt/Agent Tools/codex" --model "model name" -c reasoning_effort=high', ["codex", "omp"]), {
    executable: "/opt/Agent Tools/codex", kind: "codex",
    args: ["--model", "model name", "-c", "reasoning_effort=high"],
  });
  assert.deepEqual(parseAgentCommand("omp --model my-model", ["omp"]).args, ["--model", "my-model"]);
  for (const command of ["codex | tee log", "codex; echo hi", "codex $(pwd)", "codex\nls", 'codex --model "oops'])
    assert.throws(() => parseAgentCommand(command, ["codex"]));
  assert.throws(() => parseAgentCommand("FOO=bar codex", ["codex"]), /环境变量/);
  assert.deepEqual(parseAgentCommand("unknown-agent --model x", ["codex"]), {
    executable: "unknown-agent", kind: undefined, args: ["--model", "x"],
  });
  assert.deepEqual(parseAgentCommand('npx --yes custom-agent --model local', ["codex"]), {
    executable: "npx", kind: undefined, args: ["--yes", "custom-agent", "--model", "local"],
  });
});
