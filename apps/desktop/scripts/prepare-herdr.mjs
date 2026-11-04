import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cacheRoot = resolve(here, "../.herdr-cache");
const releaseApi = "https://api.github.com/repos/herdrdev/herdr/releases/latest";

function version(text) {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(text.trim())?.[1];
}

function githubHeaders(env, accept) {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return {
    Accept: accept,
    "User-Agent": "Crewvane",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function checkedVersion(path, cacheDir) {
  // Some Herdr builds update themselves when invoked. Probe a disposable copy
  // so the verified release asset kept in the package cache remains byte-for-
  // byte identical to the digest published by GitHub.
  await mkdir(cacheDir, { recursive: true });
  const probe = join(cacheDir, `.version-probe-${randomUUID()}`);
  await copyFile(path, probe);
  await chmod(probe, 0o700);
  try {
    const { stdout } = await exec(probe, ["--version"], { timeout: 10_000 });
    if (!/^herdr\s/i.test(stdout.trim()) || !version(stdout))
      throw new Error(`不是可执行的 Herdr：${path}`);
    return version(stdout);
  } finally {
    await rm(probe, { force: true });
  }
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function requestHerdr(url, options, timeout, action) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError"
        ? "网络超时"
        : cause instanceof Error
          ? cause.message
          : "网络请求失败";
    throw new Error(
      `${action}失败：${reason}。可设置 CREWVANE_HERDR_BINARY 使用已验证的本地 Herdr 离线打包。`,
      { cause },
    );
  }
}

/**
 * Prepares the current official Herdr binary for inclusion in the application
 * bundle. CI must use the verified release asset; an explicit local source path
 * is available for offline packaging and is still checked by its --version.
 */
export async function prepareHerdr(env = process.env) {
  const cacheDir = resolve(env.CREWVANE_HERDR_CACHE_DIR ?? cacheRoot);
  const cached = join(cacheDir, "herdr");
  if (env.CREWVANE_HERDR_BINARY) {
    const source = resolve(env.CREWVANE_HERDR_BINARY);
    if (!(await stat(source)).isFile())
      throw new Error(`CREWVANE_HERDR_BINARY 不是文件：${source}`);
    const found = await checkedVersion(source, cacheDir);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cached, await readFile(source), { mode: 0o700 });
    await chmod(cached, 0o700);
    console.log(`Bundled explicitly supplied Herdr ${found}`);
    return cached;
  }

  const target = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
  const response = await requestHerdr(releaseApi, {
    headers: githubHeaders(env, "application/vnd.github+json"),
  }, 30_000, "读取 Herdr 最新版本");
  if (!response.ok)
    throw new Error(
      `无法读取 Herdr 最新版本（HTTP ${response.status}）。CI 中请提供只读 GITHUB_TOKEN，或设置 CREWVANE_HERDR_BINARY 使用已验证的本地 Herdr 离线打包。`,
    );
  const data = await response.json();
  const expectedVersion = /^v?(\d+\.\d+\.\d+)$/.exec(data.tag_name ?? "")?.[1];
  const asset = Array.isArray(data.assets)
    ? data.assets.find(item => item?.name === `herdr-${target}`)
    : undefined;
  const expectedDigest = /^sha256:([a-f\d]{64})$/i.exec(asset?.digest ?? "")?.[1];
  if (!expectedVersion || !asset?.url || !expectedDigest)
    throw new Error(`Herdr ${data.tag_name ?? "latest"} 缺少 ${target} 的有效资产或 SHA-256`);

  try {
    if (await digest(cached) === expectedDigest.toLowerCase() &&
      await checkedVersion(cached, cacheDir) === expectedVersion) {
      console.log(`Reused verified Herdr ${expectedVersion}`);
      return cached;
    }
  } catch { /* download or replace an invalid cache */ }

  const download = await requestHerdr(asset.url, {
    headers: githubHeaders(env, "application/octet-stream"),
  }, 180_000, "下载 Herdr");
  if (!download.ok)
    throw new Error(`无法下载 Herdr ${expectedVersion}（HTTP ${download.status}）`);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.length > 100 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== expectedDigest.toLowerCase())
    throw new Error(`Herdr ${expectedVersion} 下载校验失败`);
  await mkdir(cacheDir, { recursive: true });
  const temporary = `${cached}.download`;
  try {
    await writeFile(temporary, bytes, { mode: 0o700 });
    await chmod(temporary, 0o700);
    if (await checkedVersion(temporary, cacheDir) !== expectedVersion)
      throw new Error(`Herdr 下载文件版本不匹配：期望 ${expectedVersion}`);
    await rename(temporary, cached);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Downloaded and verified Herdr ${expectedVersion}`);
  return cached;
}
