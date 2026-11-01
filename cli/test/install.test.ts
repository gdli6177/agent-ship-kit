import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installSh = join(repoRoot, "install.sh");

function which(command: string): string {
  const env = { ...process.env };
  delete env.npm_config_prefix;
  return execFileSync("bash", ["-c", `command -v ${command}`], { encoding: "utf8", env }).trim();
}

const toolPath = [dirname(process.execPath), dirname(which("npm")), dirname(which("tar")), dirname(which("curl")), "/usr/bin", "/bin"]
  .filter((dir, index, all) => dir !== "" && all.indexOf(dir) === index)
  .join(":");

function baseEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: extra.PATH ?? toolPath,
    AGENT_SHIP_REF: "",
    AGENT_SHIP_HOME: "",
    AGENT_SHIP_BIN_DIR: "",
    AGENT_SHIP_TARBALL: extra.AGENT_SHIP_TARBALL ?? "",
    npm_config_cache: extra.npm_config_cache ?? join(home, ".npm-cache"),
    npm_config_update_notifier: "false",
  };
  delete env.npm_config_prefix;
  return env;
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await exec("bash", args, {
      env,
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

test("install.sh does not invoke sudo and prints the one-liner", async () => {
  const text = await readFile(installSh, "utf8");
  const executable = text.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#") && !trimmed.includes("never uses sudo");
  });
  assert.equal(executable.some((line) => /\bsudo\b/.test(line)), false);
  const home = await mkdtemp(join(tmpdir(), "agent-ship-help-"));
  try {
    const help = await run([installSh, "--help"], baseEnv(home));
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/gdli6177\/agent-ship-kit\/main\/install\.sh \| bash/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install.sh rejects a ref with a slash and an old Node", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-ship-ref-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "node"),
    `#!/bin/sh
case "$1" in
  -p) echo 18 ;;
  -v) echo v18.19.0 ;;
  *) echo v18.19.0 ;;
esac
`,
  );
  await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "node"), 0o755);
  await chmod(join(bin, "npm"), 0o755);
  try {
    const slash = await run([installSh, "--ref", "feature/thing"], baseEnv(home));
    assert.notEqual(slash.code, 0);
    assert.match(slash.stderr, /ref/);
    await assert.rejects(access(join(home, ".agent-ship-kit")));

    const old = await run([installSh], baseEnv(home, { PATH: `${bin}:${toolPath}` }));
    assert.notEqual(old.code, 0);
    assert.match(old.stderr, /Node\.js 20/);
    await assert.rejects(access(join(home, ".agent-ship-kit")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install.sh installs from AGENT_SHIP_TARBALL and uninstalls only its skills", { timeout: 300_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "agent-ship-install-"));
  const home = join(sandbox, "home");
  const cache = join(sandbox, "npm-cache");
  const tarball = join(sandbox, "kit.tar.gz");
  const cursorSkills = join(home, ".cursor", "skills");
  const unrelated = join(cursorSkills, "unrelated-skill");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "SKILL.md"), "leave me alone\n");
  await exec(
    "tar",
    ["-czf", tarball, "--exclude", "node_modules", "--exclude", ".git", "-C", repoRoot, "."],
    { timeout: 60_000 },
  );
  const env = baseEnv(home, { AGENT_SHIP_TARBALL: tarball, npm_config_cache: cache });
  try {
    const installed = await run([installSh], env);
    assert.equal(installed.code, 0, `${installed.stdout}\n${installed.stderr}`);
    assert.match(installed.stderr, /not on PATH/);
    assert.match(installed.stdout, /\/ship-setup/);
    assert.match(installed.stdout, /agent-ship-kit installed/);

    const kit = join(home, ".agent-ship-kit", "main");
    const shim = join(home, ".local", "bin", "agent-ship");
    const shimText = await readFile(shim, "utf8");
    assert.match(shimText, /agent-ship-kit-shim/);
    assert.match(shimText, /cli\/bin\/agent-ship\.js/);
    const skill = await readFile(join(cursorSkills, "ship-setup", "SKILL.md"), "utf8");
    assert.match(skill, /agent-ship setup/);
    assert.doesNotMatch(skill, /npm run agent-ship/);
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");
    await assert.rejects(access(join(home, ".claude", "skills", "ship-setup", "SKILL.md")));

    const helpEnv = { ...env, PATH: `${join(home, ".local", "bin")}:${env.PATH}` };
    const help = await exec(shim, ["--help"], { env: helpEnv, encoding: "utf8", timeout: 60_000 });
    assert.match(help.stdout, /agent-ship/);

    const hookStyle = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
      cwd: join(kit, "cli"),
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(hookStyle.stdout, /agent-ship/);

    await writeFile(join(cursorSkills, "ship-setup", "MARKER"), "stale\n");
    const again = await run([installSh], env);
    assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
    await assert.rejects(access(join(cursorSkills, "ship-setup", "MARKER")));
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");

    const removed = await run([installSh, "--uninstall"], env);
    assert.equal(removed.code, 0, `${removed.stdout}\n${removed.stderr}`);
    assert.match(removed.stdout, /agent-ship-kit removed/);
    await assert.rejects(access(shim));
    await assert.rejects(access(kit));
    await assert.rejects(access(join(cursorSkills, "ship-setup")));
    await assert.rejects(access(join(home, ".agent-ship-kit", "manifest")));
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
