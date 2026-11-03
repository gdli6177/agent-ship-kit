import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { RpcProcess, type Wire } from "./rpc.js";
import {
  redact,
  type RuntimeAdapter,
  type RuntimeId,
  type RuntimeInfo,
  type RuntimeModel,
  type RuntimeSession,
  type SessionOptions,
} from "../../core/src/index.js";
const exec = promisify(execFile);
function modelsFromAcp(result: Wire): RuntimeModel[] {
  const option = (result.configOptions ?? []).find(
    (o: Wire) => o.category === "model" || o.id === "model",
  );
  const efforts = (result.configOptions ?? []).find(
    (o: Wire) =>
      ["thought_level", "reasoning_effort"].includes(o.category) ||
      /effort|thinking/.test(o.id),
  );
  const flatten = (values: Wire[]): Wire[] =>
    values.flatMap((o) =>
      Array.isArray(o.options) ? flatten(o.options) : [o],
    );
  if (option)
    return flatten(option.options ?? [])
      .filter((o) => typeof o.value === "string")
      .map((o) => ({
        id: o.value,
        name: o.name ?? o.value,
        ...(efforts
          ? { efforts: flatten(efforts.options ?? []).map((e) => e.value) }
          : {}),
      }));
  return (result.models?.availableModels ?? []).map((m: Wire) => ({
    id: m.modelId,
    name: m.name ?? m.modelId,
  }));
}
export class ProtocolAdapter implements RuntimeAdapter {
  readonly id: RuntimeId;
  constructor(readonly info: RuntimeInfo) {
    this.id = info.id;
  }
  async probe(cwd: string): Promise<RuntimeInfo> {
    if (
      !this.info.executable ||
      this.info.protocol === "none" ||
      this.info.capabilities?.dispatch === false
    )
      return this.info;
    let session: RuntimeSession | undefined;
    try {
      const version = (
        await exec(this.info.executable, ["--version"], {
          timeout: 12_000,
          maxBuffer: 4096,
        })
      ).stdout.trim();
      if (
        this.id === "dsh" &&
        !this.info.application?.endsWith("/DeepSeek Harness.app") &&
        !/deepseek|harness|dsh\s+v?\d/i.test(version)
      )
        throw new Error("dsh executable is not identified as DeepSeek Harness");
      session = await this.open({
        cwd,
        model: "",
        role: "captain",
        onEvent: () => {},
        permission: async () => false,
      });
      return {
        ...this.info,
        version,
        models: session.models,
        status: session.models.length ? "ready" : "unavailable",
        reason: session.models.length ? undefined : "运行时未返回可用模型",
        checkedAt: new Date().toISOString(),
      };
    } catch (e) {
      return {
        ...this.info,
        status: "unavailable",
        reason: redact(String(e)),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      await session?.close();
    }
  }
  async open(options: SessionOptions): Promise<RuntimeSession> {
    if (
      !this.info.executable ||
      this.info.protocol === "none" ||
      this.info.capabilities?.dispatch === false
    )
      throw new Error("runtime is not dispatchable");
    const codex = this.info.protocol === "codex-app-server";
    let sessionId = "",
      turnId = "",
      output = "",
      busy = false;
    let done: ((value: string) => void) | undefined,
      failed: ((error: Error) => void) | undefined;
    let cap: Wire = {};
    const filePolicy: Record<string, string> = {
      ":minimal": "read",
      [options.cwd]: options.role === "worker" ? "write" : "read",
      [`${options.cwd}/.git`]: "read",
      [`${options.cwd}/.agents`]: "read",
      [`${options.cwd}/.crewvane`]: "deny",
      [`${options.cwd}/**/.env*`]: "deny",
      [`${options.cwd}/.env*`]: "deny",
      [`${options.cwd}/**/credentials*`]: "deny",
      [`${options.cwd}/**/secrets`]: "deny",
    };
    if (codex) {
      try {
        const common = (
          await exec("git", ["rev-parse", "--git-common-dir"], {
            cwd: options.cwd,
            timeout: 5000,
          })
        ).stdout.trim();
        filePolicy[await realpath(resolve(options.cwd, common))] = "read";
      } catch {
        /* protocol probes may run outside Git */
      }
    }
    const tomlPolicy = `{${Object.entries(filePolicy)
      .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
      .join(",")}}`;
    const rpc = new RpcProcess(
      this.info.executable,
      codex
        ? [
            ...(this.info.launchArgs ?? [
              "app-server",
              "--listen",
              "stdio://",
            ]),
            "-c",
            `permissions.crewvane.filesystem=${tomlPolicy}`,
            "-c",
            "permissions.crewvane.network.enabled=false",
            "-c",
            'default_permissions="crewvane"',
          ]
        : (this.info.launchArgs ?? ["acp"]),
      options.cwd,
      !codex,
      async (method, params) => {
        options.onEvent({
          type: "permission",
          sessionId,
          text: redact(`${method}: ${JSON.stringify(params)}`).slice(0, 2000),
        });
        if (!codex && method === "session/request_permission") {
          const allow = await options.permission({ method, params });
          const choice = (params.options ?? []).find(
            (o: Wire) => o.kind === (allow ? "allow_once" : "reject_once"),
          );
          return {
            outcome: choice
              ? { outcome: "selected", optionId: choice.optionId }
              : { outcome: "cancelled" },
          };
        }
        if (
          codex &&
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
          ].includes(method)
        )
          return {
            decision: (await options.permission({ method, params }))
              ? "accept"
              : "decline",
          };
        if (codex && method === "item/permissions/requestApproval")
          return { permissions: {}, scope: "turn" };
        if (codex && method === "item/tool/requestUserInput")
          return {
            answers: Object.fromEntries(
              (params.questions ?? []).map((q: Wire) => [
                q.id,
                {
                  answers: [
                    "Return a blocked StageResult with the question for your immediate parent. Do not ask the human directly.",
                  ],
                },
              ]),
            ),
          };
        if (codex && method === "mcpServer/elicitation/request")
          return { action: "decline", content: null };
        throw new Error(`unsupported runtime request ${method}`);
      },
    );
    rpc.on("closed", (error: Error) => failed?.(error));
    rpc.on("notification", (method: string, params: Wire) => {
      if (codex && params.threadId && params.threadId !== sessionId) return;
      if (!codex && params.sessionId && params.sessionId !== sessionId) return;
      if (codex && method === "turn/started")
        turnId = params.turn?.id ?? turnId;
      let delta = "";
      if (codex && method === "item/agentMessage/delta")
        delta = params.delta ?? "";
      if (!codex && method === "session/update") {
        if (params.update?.sessionUpdate === "agent_message_chunk")
          delta =
            params.update.content?.type === "text"
              ? params.update.content.text
              : "";
        if (params.update?.sessionUpdate === "tool_call")
          options.onEvent({
            type: "tool",
            sessionId,
            text: redact(params.update.title ?? "tool"),
          });
      }
      if (delta) {
        output += delta;
        if (output.length > 250_000) {
          failed?.(new Error("runtime output exceeds limit"));
          void rpc.close();
        } else
          options.onEvent({ type: "text", sessionId, text: redact(delta) });
      }
      if (codex && method === "turn/completed") {
        const status = params.turn?.status;
        if (status === "completed") done?.(output);
        else
          failed?.(
            new Error(
              `Codex turn ${status}: ${redact(JSON.stringify(params.turn?.error ?? ""))}`,
            ),
          );
      }
    });
    try {
      let models: RuntimeModel[];
      if (codex) {
        await rpc.request("initialize", {
          clientInfo: { name: "crewvane", title: "Crewvane", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        rpc.notify("initialized", {});
        models = [];
        let cursor: string | null = null;
        do {
          const page = await rpc.request("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          });
          models.push(
            ...(page.data ?? []).map((m: Wire) => ({
              id: m.model ?? m.id,
              name: m.displayName ?? m.id,
              efforts: (m.supportedReasoningEfforts ?? []).map(
                (e: Wire) => e.reasoningEffort,
              ),
            })),
          );
          cursor = page.nextCursor;
        } while (cursor && models.length < 500);
        if (options.model && !models.some((m) => m.id === options.model))
          throw new Error(`model unavailable: ${options.model}`);
        const params = {
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          approvalPolicy: "on-request",
          baseInstructions:
            "You are a registered Crewvane agent. Do not create native subagents. Return questions to your immediate parent. Never publish, merge, deploy, access secrets or change permissions.",
        };
        const result = await rpc.request(
          options.resume ? "thread/resume" : "thread/start",
          {
            ...params,
            ...(options.resume
              ? { threadId: options.resume, excludeTurns: true }
              : {}),
          },
          60_000,
        );
        sessionId = result.thread?.id;
      } else {
        const init = await rpc.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "crewvane", version: "0.1.0" },
          clientCapabilities: {},
        });
        cap = init.agentCapabilities ?? {};
        const resumeMethod =
          this.id === "dsh"
            ? "session/resume"
            : cap.sessionCapabilities?.resume
              ? "session/resume"
              : "session/load";
        const result = await rpc.request(
          options.resume ? resumeMethod : "session/new",
          {
            cwd: options.cwd,
            mcpServers: [],
            ...(options.resume ? { sessionId: options.resume } : {}),
          },
          60_000,
        );
        sessionId = options.resume ?? result.sessionId;
        models = modelsFromAcp(result);
        if (options.model) {
          if (!models.some((m) => m.id === options.model))
            throw new Error(`model unavailable: ${options.model}`);
          const config = (result.configOptions ?? []).find(
            (o: Wire) => o.category === "model" || o.id === "model",
          );
          if (config)
            await rpc.request("session/set_config_option", {
              sessionId,
              configId: config.id,
              value: options.model,
            });
          else
            await rpc.request("session/set_model", {
              sessionId,
              modelId: options.model,
            });
        }
        if (options.effort) {
          const config = (result.configOptions ?? []).find(
            (o: Wire) =>
              ["thought_level", "reasoning_effort"].includes(o.category) ||
              /effort|thinking/.test(o.id),
          );
          if (
            !config ||
            !models
              .find((m) => m.id === options.model)
              ?.efforts?.includes(options.effort)
          )
            throw new Error("unsupported reasoning effort");
          await rpc.request("session/set_config_option", {
            sessionId,
            configId: config.id,
            value: options.effort,
          });
        }
      }
      if (!sessionId) throw new Error("runtime returned no session id");
      return {
        id: sessionId,
        pid: rpc.pid,
        models,
        prompt: async (text) => {
          if (busy) throw new Error("session already running");
          busy = true;
          output = "";
          try {
            if (!codex) {
              await rpc.request(
                "session/prompt",
                { sessionId, prompt: [{ type: "text", text }] },
                15 * 60_000,
              );
              return output;
            }
            const completion = new Promise<string>((resolve, reject) => {
              done = resolve;
              failed = reject;
            });
            // Start listening before turn/start; tiny turns can complete before the response arrives.
            const start = rpc.request("turn/start", {
              threadId: sessionId,
              cwd: options.cwd,
              input: [{ type: "text", text }],
              ...(options.model ? { model: options.model } : {}),
              ...(options.effort ? { effort: options.effort } : {}),
            });
            start.catch((error) => failed?.(error));
            const [result, completed] = await Promise.all([start, completion]);
            turnId = result.turn?.id ?? turnId;
            return completed;
          } finally {
            busy = false;
            done = undefined;
            failed = undefined;
          }
        },
        cancel: async () => {
          if (codex && turnId)
            await rpc.request(
              "turn/interrupt",
              { threadId: sessionId, turnId },
              5000,
            );
          else if (!codex) rpc.notify("session/cancel", { sessionId });
        },
        close: async () => {
          if (this.id === "dsh" && cap.sessionCapabilities?.close)
            await rpc
              .request("session/close", { sessionId }, 5000)
              .catch(() => {});
          await rpc.close();
        },
      };
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }
}
