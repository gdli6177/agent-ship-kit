import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Executables } from "./executables.js";
const exec = promisify(execFile);
const MANIFEST = "https://herdr.dev/latest.json";
export interface HerdrStatus {
  installed: boolean; executable?: string; version?: string; latestVersion?: string;
  phase: "checking" | "downloading" | "ready" | "error";
  detail?: string; updateAvailable?: boolean;
}
function version(text: string) {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(text.trim())?.[1];
}
function compare(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}
export class HerdrInstallation {
  private current: HerdrStatus = { installed: false, phase: "checking" };
  private pending?: Promise<HerdrStatus>;
  private manifest?: { at: number; value: { version: string; url: string; sha256: string } };
  constructor(readonly tools: Executables, readonly managedPath: string,
    readonly emit: (status: HerdrStatus) => void,
    readonly fetcher: typeof fetch = fetch,
    readonly platform = process.platform, readonly arch = process.arch) {}
  private publish(status: HerdrStatus) { this.current = status; this.emit({ ...status }); return { ...status }; }
  private async installed() {
    // A file existing is not enough: wrong-architecture/stale executables must
    // not be advertised as usable. Continue looking after an invalid candidate.
    const candidates = [...new Set([this.managedPath, ...(await this.tools.paths()).map(dir => `${dir}/herdr`)])];
    let best: { executable: string; version: string } | undefined;
    for (const executable of candidates) {
      try {
        const text = (await exec(executable, ["--version"], { timeout: 3_000 })).stdout;
        const found = version(text);
        if (found && /^herdr\s/i.test(text.trim()) && (!best || compare(found, best.version) > 0))
          best = { executable, version: found };
      } catch { /* try other installation locations */ }
    }
    return best;
  }
  async status() {
    if (this.pending) return { ...this.current };
    const installed = await this.installed();
    if (this.pending) return { ...this.current };
    return this.current = { ...this.current, installed: !!installed, ...installed,
      ...(!installed ? { executable: undefined, version: undefined } : {}),
      phase: this.current.phase === "error" ? "error" : installed ? "ready" : "checking" };
  }
  ensure(force = false): Promise<HerdrStatus> {
    if (this.pending) return this.pending;
    this.pending = this.prepare(force).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async latest(force: boolean) {
    if (!force && this.manifest && Date.now() - this.manifest.at < 6 * 3600_000) return this.manifest.value;
    const response = await this.fetcher(MANIFEST, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error(`版本检查失败（HTTP ${response.status}）`);
    const data = await response.json() as any;
    const target = `${this.platform === "darwin" ? "macos" : this.platform}-${this.arch === "arm64" ? "aarch64" : this.arch === "x64" ? "x86_64" : this.arch}`;
    const url = data.assets?.[target], sha256 = data.sha256?.[target];
    // Use the official TUI manifest, not the separate Herdr native app.
    const expected = `https://github.com/herdrdev/herdr/releases/download/v${data.version}/herdr-${target}`;
    if (!/^\d+\.\d+\.\d+$/.test(data.version) || url !== expected || !/^[a-f\d]{64}$/i.test(sha256 ?? ""))
      throw new Error("官方版本清单缺少当前平台的有效下载与 SHA-256");
    const value = { version: data.version as string, url, sha256: sha256.toLowerCase() };
    this.manifest = { at: Date.now(), value };
    return value;
  }
  private async prepare(force: boolean) {
    const local = await this.installed();
    this.publish({ installed: !!local, ...local, phase: "checking", detail: "正在检查 Herdr 最新版本…" });
    let temporary: string | undefined;
    try {
      const latest = await this.latest(force);
      if (local && compare(local.version, latest.version) >= 0)
        return this.publish({ installed: true, ...local, latestVersion: latest.version, phase: "ready" });
      this.publish({ installed: !!local, ...local, latestVersion: latest.version, phase: "downloading",
        updateAvailable: !!local, detail: local ? `正在准备 Herdr ${latest.version}…` : "正在自动安装 Herdr，无需 Homebrew…" });
      const response = await this.fetcher(latest.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 100 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== latest.sha256)
        throw new Error("Herdr 下载校验失败，未安装该文件");
      await mkdir(dirname(this.managedPath), { recursive: true });
      temporary = `${this.managedPath}.download`;
      await writeFile(temporary, bytes, { mode: 0o700 });
      await chmod(temporary, 0o700);
      const checked = version((await exec(temporary, ["--version"], { timeout: 10_000 })).stdout);
      if (checked !== latest.version) throw new Error("下载的 Herdr 无法运行或版本不匹配");
      await rename(temporary, this.managedPath);
      temporary = undefined;
      return this.publish({ installed: true, executable: this.managedPath,
        version: checked, latestVersion: latest.version, phase: "ready" });
    } catch (error) {
      const detail = `Herdr 自动准备未完成：${error instanceof Error ? error.message : String(error)}`;
      this.publish({ installed: !!local, ...local, phase: "error",
        detail: local ? `${detail}。继续使用本机 ${local.version}，可稍后重试检查。` : `${detail}。请检查网络后点击重试。` });
      if (local) return { ...this.current };
      throw new Error(this.current.detail);
    } finally {
      if (temporary) await rm(temporary, { force: true });
    }
  }
}
