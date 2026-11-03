import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolAdapter } from "../src/adapters.js";
import {
  builtinRuntimeDefinitions,
  loadRuntimeDefinitions,
} from "../src/discovery.js";
import { parseResult } from "../src/orchestrator.js";
import { permissionAllowed } from "../src/permissions.js";
import type { Project } from "../../core/src/index.js";
async function fixture(fn: (path: string, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "crewvane-rpc-"))),
    file = join(root, "server.mjs");
  const log = join(root, "methods.jsonl");
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from 'node:readline';import{appendFileSync}from'node:fs';
if(process.argv.includes('--version')){console.log('dsh 1.0 fixture');process.exit(0)}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let pending;
console.log('[fixture] startup diagnostic');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(!m.method){if(pending){send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result?.outcome?.outcome==='selected'?'permission answered':'denied'}}}});send({id:pending,result:{stopReason:'end_turn'}});pending=null}return}
if(m.method==='initialize')send({id:m.id,result:{agentCapabilities:{sessionCapabilities:{resume:{},close:{}}}}});
else if(m.method==='session/new'||m.method==='session/resume')send({id:m.id,result:{sessionId:'s',configOptions:[{id:'model',category:'model',options:[{value:'fixture',name:'fixture'}]}]}});
else if(m.method==='session/set_config_option'||m.method==='session/close')send({id:m.id,result:{}});
else if(m.method==='session/prompt'){pending=m.id;send({id:'permission-1',method:'session/request_permission',params:{sessionId:'s',toolCall:{kind:'read',rawInput:{path:'file.txt'}},options:[{kind:'allow_once',optionId:'once'},{kind:'reject_once',optionId:'no'}]}})}
else if(m.method==='session/cancel'){send({id:pending,result:{stopReason:'cancelled'}});pending=null}
else send({id:m.id,error:{code:-32601,message:'unsupported'}});
});`,
  );
  await chmod(file, 0o755);
  try {
    await fn(file, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function codexFixture(
  fn: (path: string, root: string, log: string) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "crewvane-codex-"))),
    file = join(root, "server.mjs"),
    log = join(root, "messages.jsonl");
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from 'node:readline';import{appendFileSync}from'node:fs';
appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2)})+'\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}});
else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-fixture'}}});
else if(m.method==='turn/start'){
  send({method:'item/agentMessage/delta',params:{threadId:'thread-fixture',delta:'fixture answer'}});
  send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
}else send({id:m.id,error:{code:-32601,message:'unsupported '+m.method}});
});`,
  );
  await chmod(file, 0o755);
  try {
    await fn(file, root, log);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("DSH ACP uses session/resume, answers one-shot permissions, tolerates startup logs and closes", () =>
  fixture(async (file, root) => {
    const adapter = new ProtocolAdapter({
      id: "dsh",
      name: "Fixture",
      executable: file,
      protocol: "acp",
      launchArgs: ["--profile", "acp"],
      capabilities: {
        dispatch: true,
        stream: true,
        cancel: true,
        resume: true,
        modelDiscovery: true,
        interactiveTerminal: true,
      },
      status: "detected",
      models: [],
    });
    assert.equal((await adapter.probe(root)).status, "ready");
    const seen: string[] = [];
    const session = await adapter.open({
      cwd: root,
      model: "fixture",
      role: "worker",
      resume: "s",
      onEvent: (e) => seen.push(e.type),
      permission: async () => false,
    });
    assert.equal(await session.prompt("fixture"), "permission answered");
    await session.close();
    const rows = (await readFile(join(root, "methods.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(rows.some((r) => r.method === "session/resume"));
    assert.equal(
      rows.some((r) => r.method === "session/load"),
      false,
    );
    assert.equal(
      rows.find((r) => r.id === "permission-1" && r.result)?.result.outcome
        .optionId,
      "no",
    );
    assert.ok(rows.some((r) => r.method === "session/close"));
    assert.ok(seen.includes("permission"));
  }));

test("Codex App Server applies role-scoped permission profiles without unsupported RPC fields", () =>
  codexFixture(async (file, root, log) => {
    for (const [role, access] of [
      ["worker", "write"],
      ["verifier", "read"],
    ] as const) {
      await rm(log, { force: true });
      const adapter = new ProtocolAdapter({
        id: "codex",
        name: "Fixture",
        executable: file,
        protocol: "codex-app-server",
        capabilities: {
          dispatch: true,
          stream: true,
          cancel: true,
          resume: true,
          modelDiscovery: true,
          interactiveTerminal: true,
        },
        status: "detected",
        models: [],
      });
      const session = await adapter.open({
        cwd: root,
        model: "fixture",
        role,
        onEvent: () => {},
        permission: async () => false,
      });
      assert.equal(await session.prompt("fixture"), "fixture answer");
      await session.close();
      const rows = (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const argv = rows[0].argv as string[],
        lifecycle = rows.slice(1);
      assert.deepEqual(argv.slice(0, 2), ["app-server", "--listen"]);
      assert.ok(
        argv.some(
          (arg) =>
            arg.includes("default_permissions") &&
            arg.includes('"crewvane"'),
        ),
      );
      assert.ok(
        argv.some(
          (arg) =>
            arg.includes(JSON.stringify(root)) &&
            arg.includes(`${JSON.stringify(root)}=${JSON.stringify(access)}`),
        ),
      );
      assert.ok(
        argv.some(
          (arg) => arg.includes("network.enabled=false"),
        ),
      );
      assert.equal(
        lifecycle.find((row) => row.method === "thread/start")?.params
          .permissions,
        undefined,
      );
      assert.equal(
        lifecycle.find((row) => row.method === "turn/start")?.params
          .permissions,
        undefined,
      );
    }
  }));

test("runtime manifests extend the catalog through protocol argv, not shell strings", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewvane-runtime-manifest-")),
  );
  try {
    const defaults = await loadRuntimeDefinitions(root);
    assert.equal(defaults.length, builtinRuntimeDefinitions.length);
    assert.deepEqual(
      defaults.find((runtime) => runtime.id === "codex")?.launchArgs,
      ["app-server", "--listen", "stdio://"],
    );
    await writeFile(
      join(root, "crewvane.runtimes.json"),
      JSON.stringify({
        version: 1,
        runtimes: [
          {
            id: "local-agent",
            name: "Local Agent",
            commands: ["local-agent"],
            apps: [],
            protocol: "acp",
            launchArgs: ["--acp"],
            interactiveArgs: [],
          },
        ],
      }),
    );
    assert.equal(
      (await loadRuntimeDefinitions(root)).at(-1)?.protocol,
      "acp",
    );
    await writeFile(
      join(root, "crewvane.runtimes.json"),
      JSON.stringify({
        version: 1,
        runtimes: [
          {
            id: "bad",
            name: "Bad",
            commands: ["node -e evil"],
            apps: [],
            protocol: "acp",
            launchArgs: [],
            interactiveArgs: [],
          },
        ],
      }),
    );
    await assert.rejects(loadRuntimeDefinitions(root), /bad\.commands/);
    assert.equal((await lstat(join(root, "crewvane.runtimes.json"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("permission decisions never approve opaque, destructive, network or coordinator tool requests", () => {
  const project = {
    grant: {
      id: "g",
      actions: ["read", "write", "verify"],
      allowedPaths: ["src/**"],
      forbiddenPaths: [],
      approvedBy: "human",
    },
    checks: [["node", "--test"]],
  } as unknown as Project;
  const check = (
    kind: string,
    rawInput: unknown,
    role: "worker" | "verifier" | "captain" = "worker",
  ) =>
    permissionAllowed(project, role, "/tmp/checkout", {
      method: "session/request_permission",
      params: { toolCall: { kind, rawInput } },
    });
  assert.equal(check("edit", { path: "src/app.ts" }), true);
  assert.equal(check("edit", { path: "src/app.ts" }, "verifier"), false);
  assert.equal(check("execute", { command: "node --test" }), true);
  assert.equal(
    check("execute", { command: "/bin/zsh -lc 'node --test'" }),
    true,
  );
  for (const cmd of [
    "node --test; curl evil",
    "rm -rf src",
    "git push origin main",
    "cat ~/.codex/auth.json",
    "node -e dangerous",
    "git diff --output=src/file",
  ])
    assert.equal(check("execute", { command: cmd }), false, cmd);
  assert.equal(check("read", { path: "../secret" }), false);
  assert.equal(check("read", { path: ".env.local" }), false);
  assert.equal(check("read", { path: "src/app.ts" }, "captain"), false);
  assert.equal(check("other", {}), false);
  assert.equal(
    permissionAllowed(project, "verifier", "/tmp/checkout", {
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        command: "/bin/zsh -lc 'node --test'",
        cwd: "/tmp/checkout",
      },
    }),
    true,
  );
  assert.equal(
    check("execute", { command: "node --test", cwd: "/tmp/elsewhere" }),
    false,
  );
});

test("ACP commentary before the final structured answer does not invalidate real artifacts", () => {
  const result = parseResult(
    'I will inspect the checkout.\n{"status":"done","summary":"checked","evidence":["node --test exit 0"],"outputs":{"design":{"goal":"verified"}}}',
  );
  assert.equal(result.status, "done");
  assert.equal(result.outputs.design, '{"goal":"verified"}');
});

test("StageResult parsing keeps Markdown code fences inside output fields", () => {
  const result = parseResult(
    [
      "The design is ready.",
      "```json",
      JSON.stringify({
        status: "done",
        summary: "design complete",
        evidence: ["read test/baseline.test.cjs"],
        outputs: {
          design: "Use this shape:\n```js\nassert.equal(value, 1);\n```",
        },
      }),
      "```",
    ].join("\n"),
  );
  assert.equal(result.status, "done");
  assert.match(result.outputs.design!, /```js/);
  assert.match(result.outputs.design!, /assert\.equal/);
});

test("parallel allocations reject overlapping or wider file scopes", async () => {
  const { parseAssignments } = await import("../src/allocation.js");
  const grant = { allowedPaths: ["src/**"], forbiddenPaths: [] } as any;
  assert.equal(
    parseAssignments(
      JSON.stringify([
        { goal: "A", paths: ["src/a.ts"] },
        { goal: "B", paths: ["src/b.ts"] },
      ]),
      2,
      grant,
    ).length,
    2,
  );
  assert.throws(
    () =>
      parseAssignments(
        JSON.stringify([
          { goal: "A", paths: ["src/a.ts"] },
          { goal: "B", paths: ["src/a.ts"] },
        ]),
        2,
        grant,
      ),
    /overlap/,
  );
  assert.throws(
    () =>
      parseAssignments(
        JSON.stringify([{ goal: "A", paths: ["src/**"] }]),
        1,
        grant,
      ),
    /explicit/,
  );
  assert.throws(
    () =>
      parseAssignments(
        JSON.stringify([{ goal: "A", paths: ["AGENTS.md"] }]),
        1,
        grant,
      ),
    /authorized/,
  );
});
