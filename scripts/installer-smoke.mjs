// Exercise both downloadable formats without requiring model credentials on CI.
import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const { version } = JSON.parse(await readFile(join(repo, "apps/desktop/package.json"), "utf8"));
const installers = join(repo, "apps/desktop/release/installers");
const stem = `Crewvane-${version}-macOS-arm64`;
const trial = await mkdtemp(join(tmpdir(), "crewvane-install-test-"));
await exec("shasum", ["-a", "256", "-c", "SHA256SUMS.txt"], { cwd: installers });
await exec("hdiutil", ["verify", join(installers, `${stem}.dmg`)]);
async function launchInstalled(appPath, label) {
  const workspace = join(trial, `${label}-workspace`);
  await mkdir(workspace);
  const app = await electron.launch({
    executablePath: join(appPath, "Contents/MacOS/Crewvane"),
    args: [],
    env: { ...process.env, CREWVANE_TEST_USER_DATA: join(trial, `${label}-userData`),
      CREWVANE_TEST_WORKSPACE: workspace },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { name: "全部目标" }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    await page.locator(".rail-bottom").getByRole("button", { name: "终端", exact: true }).click();
    await page.getByLabel("终端后端").selectOption("shell");
    await page.locator(".drawer-title small").getByText(/zsh|bash|fish|sh/).waitFor();
    await page.getByLabel("交互式终端").click();
    await page.keyboard.type("printf __installer_ok__");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      (document.querySelector(".xterm-rows")?.textContent.match(/__installer_ok__/g)?.length ?? 0) >= 2);
    assert.deepEqual(errors, []);
    console.log(`${label}: installed app starts, version matches, renderer isolated, real PTY works`);
  } finally {
    await app.close();
  }
}
let mounted = false;
const mount = join(trial, "volume");
try {
  await exec("ditto", ["-x", "-k", join(installers, `${stem}.zip`), join(trial, "zip")]);
  await launchInstalled(join(trial, "zip/Crewvane.app"), "zip");
  await mkdir(mount);
  await exec("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount,
    join(installers, `${stem}.dmg`)]);
  mounted = true;
  await access(join(mount, "Applications"));
  await exec("ditto", [join(mount, "Crewvane.app"), join(trial, "installed/Crewvane.app")]);
  await exec("hdiutil", ["detach", mount]);
  mounted = false;
  await launchInstalled(join(trial, "installed/Crewvane.app"), "dmg");
  console.log("Installer verification passed (DMG + ZIP + SHA-256)");
} finally {
  if (mounted) await exec("hdiutil", ["detach", mount]);
  await rm(trial, { recursive: true, force: true });
}
