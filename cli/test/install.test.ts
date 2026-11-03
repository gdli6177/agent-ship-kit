import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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
    CREWVANE_REF: "",
    CREWVANE_HOME: "",
    CREWVANE_BIN_DIR: "",
    CREWVANE_TARBALL: extra.CREWVANE_TARBALL ?? "",
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
  assert.match(text, /--no-update-notifier --no-fund --no-audit --silent/);
  const home = await mkdtemp(join(tmpdir(), "crewvane-help-"));
  try {
    const help = await run([installSh, "--help"], baseEnv(home));
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/gdli6177\/crewvane\/main\/install\.sh \| bash/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install.sh rejects a parent-dir ref and an old Node", async () => {
  const home = await mkdtemp(join(tmpdir(), "crewvane-ref-"));
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
    const traversal = await run([installSh, "--ref", "feature/../x"], baseEnv(home));
    assert.notEqual(traversal.code, 0);
    assert.match(traversal.stderr, /ref/);
    await assert.rejects(access(join(home, ".crewvane")));

    const old = await run([installSh], baseEnv(home, { PATH: `${bin}:${toolPath}` }));
    assert.notEqual(old.code, 0);
    assert.match(old.stderr, /Node\.js 20/);
    await assert.rejects(access(join(home, ".crewvane")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install.sh percent-encodes a slash ref for codeload", async () => {
  const home = await mkdtemp(join(tmpdir(), "crewvane-url-"));
  const bin = join(home, "bin");
  const log = join(home, "curl.log");
  await mkdir(bin);
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" > "$CURL_LOG"
exit 1
`,
  );
  await chmod(join(bin, "curl"), 0o755);
  try {
    const env = baseEnv(home, { PATH: `${bin}:${toolPath}` });
    env.CURL_LOG = log;
    const result = await run([installSh, "--ref", "feature/thing"], env);
    assert.notEqual(result.code, 0);
    assert.match(await readFile(log, "utf8"), /https:\/\/codeload\.github\.com\/gdli6177\/crewvane\/tar\.gz\/feature%2Fthing/);
    await assert.rejects(access(join(home, ".crewvane")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install.sh installs from CREWVANE_TARBALL and uninstalls only its skills", { timeout: 300_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "crewvane-install-"));
  const home = join(sandbox, "home");
  const cache = join(sandbox, "npm-cache");
  const tarball = join(sandbox, "kit.tar.gz");
  const cursorSkills = join(home, ".cursor", "skills");
  const unrelated = join(cursorSkills, "unrelated-skill");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "SKILL.md"), "leave me alone\n");
  await exec(
    "tar",
    ["-czf", tarball, "--exclude", "node_modules", "--exclude", "dist", "--exclude", "release", "--exclude", "artifacts", "--exclude", ".git", "-C", repoRoot, "."],
    { timeout: 60_000 },
  );
  const env = baseEnv(home, { CREWVANE_TARBALL: tarball, npm_config_cache: cache });
  try {
    const installed = await run([installSh], env);
    assert.equal(installed.code, 0, `${installed.stdout}\n${installed.stderr}`);
    assert.match(installed.stderr, /not on PATH/);
    assert.match(installed.stdout, /\/ship-setup/);
    assert.match(installed.stdout, /crewvane installed/);

    const kitHome = join(home, ".crewvane");
    const kit = join(kitHome, "main");
    const shim = join(home, ".local", "bin", "crewvane");
    const shimText = await readFile(shim, "utf8");
    assert.match(shimText, /crewvane-shim/);
    assert.match(shimText, /crewvane\/current\/cli\/bin\/crewvane\.js/);
    assert.equal(await readlink(join(kitHome, "current")), "main");
    const skill = await readFile(join(cursorSkills, "ship-setup", "SKILL.md"), "utf8");
    assert.match(skill, /crewvane setup/);
    assert.match(skill, /\.crewvane\/current\//);
    assert.doesNotMatch(skill, /\.crewvane\/main/);
    assert.doesNotMatch(skill, /npm run crewvane/);
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");
    await assert.rejects(access(join(home, ".claude", "skills", "ship-setup", "SKILL.md")));

    const helpEnv = { ...env, PATH: `${join(home, ".local", "bin")}:${env.PATH}` };
    const help = await exec(shim, ["--help"], { env: helpEnv, encoding: "utf8", timeout: 60_000 });
    assert.match(help.stdout, /crewvane/);

    const project = join(sandbox, "project");
    await mkdir(project);
    await exec("git", ["init", "-b", "main"], { cwd: project, env });
    await exec(shim, ["setup", "--shared", "--root", project], { env: helpEnv, encoding: "utf8", timeout: 60_000 });
    assert.match(await readFile(join(project, "docs", "agent-team", "handbook.md"), "utf8"), /团队工作手册/);
    const team = await exec(shim, ["team", "context", "--root", project], { env: helpEnv, encoding: "utf8", timeout: 60_000 });
    assert.equal(JSON.parse(team.stdout).learning_required, true);
    assert.deepEqual(JSON.parse(team.stdout).lessons, []);

    const hookStyle = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
      cwd: join(kit, "cli"),
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(hookStyle.stdout, /crewvane/);

    await writeFile(join(cursorSkills, "ship-setup", "MARKER"), "stale\n");
    const again = await run([installSh], env);
    assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
    await assert.rejects(access(join(cursorSkills, "ship-setup", "MARKER")));
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");

    const removed = await run([installSh, "--uninstall"], env);
    assert.equal(removed.code, 0, `${removed.stdout}\n${removed.stderr}`);
    assert.match(removed.stdout, /crewvane removed/);
    await assert.rejects(access(shim));
    await assert.rejects(access(kitHome));
    await assert.rejects(access(join(cursorSkills, "ship-setup")));
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a slash ref installs through current, and switching refs removes the old kit", { timeout: 300_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "crewvane-switch-"));
  const home = join(sandbox, "home");
  const cache = join(sandbox, "npm-cache");
  const tarball = join(sandbox, "kit.tar.gz");
  const cursorSkills = join(home, ".cursor", "skills");
  const unrelated = join(cursorSkills, "unrelated-skill");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "SKILL.md"), "leave me alone\n");
  await exec(
    "tar",
    ["-czf", tarball, "--exclude", "node_modules", "--exclude", "dist", "--exclude", "release", "--exclude", "artifacts", "--exclude", ".git", "-C", repoRoot, "."],
    { timeout: 60_000 },
  );
  const env = baseEnv(home, { CREWVANE_TARBALL: tarball, npm_config_cache: cache });
  const kitHome = join(home, ".crewvane");
  try {
    const slash = await run([installSh, "--ref", "feature/thing"], env);
    assert.equal(slash.code, 0, `${slash.stdout}\n${slash.stderr}`);
    assert.equal(await readlink(join(kitHome, "current")), "feature__thing");
    await access(join(kitHome, "feature__thing", "cli", "bin", "crewvane.js"));
    await assert.rejects(access(join(kitHome, "feature", "thing")));
    const skill = await readFile(join(cursorSkills, "ship-contract", "SKILL.md"), "utf8");
    assert.match(skill, /\.crewvane\/current\//);
    assert.doesNotMatch(skill, /feature__thing/);
    const shim = await readFile(join(home, ".local", "bin", "crewvane"), "utf8");
    assert.match(shim, /crewvane\/current\/cli\/bin\/crewvane\.js/);
    assert.doesNotMatch(shim, /feature__thing/);

    const helpEnv = { ...env, PATH: `${join(home, ".local", "bin")}:${env.PATH}` };
    const help = await exec(join(home, ".local", "bin", "crewvane"), ["--help"], {
      env: helpEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(help.stdout, /crewvane/);

    const switched = await run([installSh, "--ref", "v8.8.8"], env);
    assert.equal(switched.code, 0, `${switched.stdout}\n${switched.stderr}`);
    assert.equal(await readlink(join(kitHome, "current")), "v8.8.8");
    await access(join(kitHome, "v8.8.8", "package.json"));
    await assert.rejects(access(join(kitHome, "feature__thing")));
    const shimAfter = await readFile(join(home, ".local", "bin", "crewvane"), "utf8");
    assert.match(shimAfter, /crewvane\/current\/cli\/bin\/crewvane\.js/);

    const removed = await run([installSh, "--uninstall"], env);
    assert.equal(removed.code, 0, `${removed.stdout}\n${removed.stderr}`);
    await assert.rejects(access(kitHome));
    await assert.rejects(access(join(home, ".local", "bin", "crewvane")));
    await assert.rejects(access(join(cursorSkills, "ship-contract")));
    assert.equal(await readFile(join(unrelated, "SKILL.md"), "utf8"), "leave me alone\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
