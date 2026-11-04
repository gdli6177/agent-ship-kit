import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AttentionKind, Goal } from "../../../packages/core/src/index.js";

export interface WebhookSaveInput {
  enabled: boolean;
  url?: string;
  token?: string;
  clearToken?: boolean;
}

export interface WebhookSettings {
  enabled: boolean;
  configured: boolean;
  endpoint?: string;
  tokenConfigured: boolean;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface AttentionNotification {
  workspace: { name: string };
  goal: Goal;
  kind: AttentionKind;
}

interface StoredWebhook {
  enabled: boolean;
  url: string;
  token?: string;
}

interface DeliveryRecord {
  status: "sent" | "failed";
  attemptedAt: string;
  responseStatus?: number;
  detail?: string;
  nextRetryAt?: string;
}

interface NotificationFile {
  version: 1;
  webhook?: StoredWebhook;
  deliveries: Record<string, DeliveryRecord>;
  lastSuccessAt?: string;
  lastError?: { at: string; detail: string };
}

const emptyFile = (): NotificationFile => ({ version: 1, deliveries: {} });
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeUrl(value: string) {
  const raw = value.trim();
  if (!raw || raw.length > 4096) throw new Error("Webhook 地址无效");
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("请通过令牌字段认证，Webhook 地址中不能包含账号密码");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHosts.has(url.hostname)))
    throw new Error("Webhook 必须使用 HTTPS；本机 localhost 可使用 HTTP");
  return url.toString();
}

function displayEndpoint(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  return `${url.origin}${url.pathname === "/" ? "" : "/…"}`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "Webhook 请求超时";
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

export class WebhookNotifier {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    userDataDirectory: string,
    private readonly appVersion: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly retryDelayMs = 5 * 60_000,
  ) {
    this.path = join(userDataDirectory, "notification-webhooks.json");
  }

  status(): Promise<WebhookSettings> {
    return this.serial(async () => {
      const data = await this.read();
      return {
        enabled: Boolean(data.webhook?.enabled),
        configured: Boolean(data.webhook?.url),
        ...(data.webhook?.url ? { endpoint: displayEndpoint(data.webhook.url) } : {}),
        tokenConfigured: Boolean(data.webhook?.token),
        ...(data.lastSuccessAt ? { lastSuccessAt: data.lastSuccessAt } : {}),
        ...(data.lastError ? { lastError: data.lastError.detail, lastErrorAt: data.lastError.at } : {}),
      };
    });
  }

  save(input: WebhookSaveInput): Promise<WebhookSettings> {
    return this.serial(async () => {
      if (!input || typeof input.enabled !== "boolean") throw new Error("Webhook 配置无效");
      const data = await this.read(), current = data.webhook;
      const candidate = typeof input.url === "string" && input.url.trim()
        ? normalizeUrl(input.url)
        : current?.url;
      if (input.enabled && !candidate) throw new Error("启用前请填写 Webhook 地址");
      if (candidate) {
        const token = input.clearToken
          ? undefined
          : typeof input.token === "string" && input.token.trim()
            ? input.token.trim()
            : current?.token;
        if (token && (token.length > 4096 || /[\r\n]/.test(token)))
          throw new Error("Webhook 令牌无效");
        data.webhook = {
          enabled: input.enabled,
          url: candidate,
          ...(token ? { token } : {}),
        };
      } else {
        delete data.webhook;
      }
      delete data.lastError;
      await this.write(data);
      return this.settingsFrom(data);
    });
  }

  deliver(notification: AttentionNotification): Promise<{ sent: boolean; reason?: string }> {
    return this.serial(async () => {
      const data = await this.read(), webhook = data.webhook;
      if (!webhook?.enabled || !webhook.url) return { sent: false, reason: "disabled" };

      const now = this.now(), event = this.event(notification, webhook.url),
        previous = data.deliveries[event.id];
      if (previous?.status === "sent") return { sent: false, reason: "duplicate" };
      if (previous?.nextRetryAt && Date.parse(previous.nextRetryAt) > now.getTime())
        return { sent: false, reason: "backoff" };

      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await this.fetcher(webhook.url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "user-agent": `Crewvane/${this.appVersion}`,
            "x-crewvane-event": event.body.event,
            "x-crewvane-delivery": event.id,
            ...(webhook.token ? { authorization: `Bearer ${webhook.token}` } : {}),
          },
          body: JSON.stringify(event.body),
        });
        if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
        data.deliveries[event.id] = {
          status: "sent",
          attemptedAt: now.toISOString(),
          responseStatus: response.status,
        };
        data.lastSuccessAt = now.toISOString();
        delete data.lastError;
      } catch (error) {
        const detail = errorMessage(error);
        data.deliveries[event.id] = {
          status: "failed",
          attemptedAt: now.toISOString(),
          detail,
          nextRetryAt: new Date(now.getTime() + this.retryDelayMs).toISOString(),
        };
        data.lastError = { at: now.toISOString(), detail };
        await this.write(data);
        return { sent: false, reason: detail };
      } finally {
        clearTimeout(timer);
      }
      this.prune(data, now);
      await this.write(data);
      return { sent: true };
    });
  }

  test(workspaceName = "Crewvane"): Promise<WebhookSettings> {
    return this.serial(async () => {
      const data = await this.read(), webhook = data.webhook;
      if (!webhook?.url) throw new Error("请先保存 Webhook 配置");
      const now = this.now(), controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await this.fetcher(webhook.url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "user-agent": `Crewvane/${this.appVersion}`,
            "x-crewvane-event": "notification.test",
            "x-crewvane-delivery": createHash("sha256").update(`${now.toISOString()}:${webhook.url}`).digest("hex"),
            ...(webhook.token ? { authorization: `Bearer ${webhook.token}` } : {}),
          },
          body: JSON.stringify({
            schema: "crewvane.notification.v1",
            event: "notification.test",
            occurredAt: now.toISOString(),
            workspace: { name: workspaceName },
            app: { name: "Crewvane", version: this.appVersion },
            message: "这是一条 Crewvane Webhook 测试通知。",
          }),
        });
        if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
        data.lastSuccessAt = now.toISOString();
        delete data.lastError;
        await this.write(data);
      } catch (error) {
        data.lastError = { at: now.toISOString(), detail: errorMessage(error) };
        await this.write(data);
        throw error;
      } finally {
        clearTimeout(timer);
      }
      return this.settingsFrom(data);
    });
  }

  private event(notification: AttentionNotification, endpoint: string) {
    const { goal, kind, workspace } = notification,
      attention = goal.attention,
      fingerprint = [
        workspace.name, goal.id, goal.status, kind,
        attention?.since ?? goal.remindAt ?? goal.updatedAt,
        attention?.summary ?? goal.next,
        endpoint,
      ].join("\u0000"),
      id = createHash("sha256").update(fingerprint).digest("hex"),
      occurredAt = attention?.since ?? goal.remindAt ?? goal.updatedAt;
    return {
      id,
      body: {
        schema: "crewvane.notification.v1",
        event: "attention.required",
        deliveryId: id,
        occurredAt,
        workspace: { name: workspace.name },
        app: { name: "Crewvane", version: this.appVersion },
        goal: {
          id: goal.id,
          title: goal.title,
          status: goal.status,
          next: goal.next,
          kind,
          summary: attention?.summary ?? goal.next,
          ...(goal.waitingFor ? { waitingFor: goal.waitingFor } : {}),
          ...(goal.remindAt ? { remindAt: goal.remindAt } : {}),
        },
        action: { type: "open-goal", goalId: goal.id },
      },
    };
  }

  private async read(): Promise<NotificationFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<NotificationFile>;
      if (parsed.version !== 1 || !parsed.deliveries || typeof parsed.deliveries !== "object")
        return emptyFile();
      return {
        version: 1,
        ...(parsed.webhook?.url ? { webhook: parsed.webhook } : {}),
        deliveries: parsed.deliveries,
        ...(parsed.lastSuccessAt ? { lastSuccessAt: parsed.lastSuccessAt } : {}),
        ...(parsed.lastError?.at && parsed.lastError?.detail ? { lastError: parsed.lastError } : {}),
      };
    } catch {
      return emptyFile();
    }
  }

  private async write(data: NotificationFile) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private prune(data: NotificationFile, now: Date) {
    const cutoff = now.getTime() - 90 * 24 * 60 * 60_000,
      entries = Object.entries(data.deliveries)
        .filter(([, record]) => Date.parse(record.attemptedAt) >= cutoff)
        .sort((a, b) => Date.parse(b[1].attemptedAt) - Date.parse(a[1].attemptedAt))
        .slice(0, 500);
    data.deliveries = Object.fromEntries(entries);
  }

  private settingsFrom(data: NotificationFile): WebhookSettings {
    return {
      enabled: Boolean(data.webhook?.enabled),
      configured: Boolean(data.webhook?.url),
      ...(data.webhook?.url ? { endpoint: displayEndpoint(data.webhook.url) } : {}),
      tokenConfigured: Boolean(data.webhook?.token),
      ...(data.lastSuccessAt ? { lastSuccessAt: data.lastSuccessAt } : {}),
      ...(data.lastError ? { lastError: data.lastError.detail, lastErrorAt: data.lastError.at } : {}),
    };
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => {}).then(task);
    this.queue = current;
    return current;
  }
}
