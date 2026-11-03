import { createRequire } from "node:module";
import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)),
  workspace = resolve(here, "../.."),
  exec = promisify(execFile),
  electronVersion = createRequire(import.meta.url)("electron/package.json")
    .version,
  desktopPackage = JSON.parse(
    await readFile(join(here, "package.json"), "utf8"),
  ),
  signingIdentity = process.env.CREWVANE_MACOS_SIGN_IDENTITY,
  stage = await mkdtemp(join(tmpdir(), "crewvane-package-"));

try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Desktop packaging currently requires macOS arm64");
  const pnpmArgs = [
    "--filter",
    "@crewvane/desktop",
    "deploy",
    "--legacy",
    "--prod",
    "--config.node-linker=hoisted",
    stage,
  ];
  if (process.env.npm_execpath) {
    await exec(process.execPath, [process.env.npm_execpath, ...pnpmArgs], {
      cwd: workspace,
      maxBuffer: 10 * 1024 * 1024,
    });
  } else {
    await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", pnpmArgs, {
      cwd: workspace,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  await cp(join(here, "dist"), join(stage, "dist"), { recursive: true });
  await chmod(
    join(
      stage,
      "node_modules",
      "node-pty",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
    0o755,
  ).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "crewvane",
      version: desktopPackage.version,
      description: desktopPackage.description,
      productName: "Crewvane",
      main: "dist/main.cjs",
      private: false,
      dependencies: desktopPackage.dependencies,
    }),
  );
  const paths = await packager({
    dir: stage,
    out: join(here, "release"),
    name: "Crewvane",
    electronVersion,
    appBundleId: "dev.crewvane.desktop",
    platform: "darwin",
    arch: "arm64",
    asar: { unpack: "**/node_modules/node-pty/**" },
    ignore: [
      /^\/electron(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/build\.mjs$/,
      /^\/index\.html$/,
      /^\/package\.mjs$/,
      /^\/tsconfig\.json$/,
    ],
    overwrite: true,
    prune: true,
    appCategoryType: "public.app-category.developer-tools",
    // Electron patches its binaries while packaging. Re-sign every nested
    // executable and seal the app afterwards so Gatekeeper does not report the
    // downloaded app as damaged. An explicitly configured Developer ID enables
    // hardened runtime; ad-hoc builds must not mix it with Electron's bundled
    // frameworks or macOS refuses to load them in the signed helpers.
    osxSign: {
      identity: signingIdentity || "-",
      identityValidation: Boolean(signingIdentity),
      timestamp: signingIdentity ? undefined : "none",
      strictVerify: true,
      optionsForFile: () => ({
        hardenedRuntime: Boolean(signingIdentity),
        ...(signingIdentity ? {} : { entitlements: [] }),
      }),
    },
  });
  console.log(paths.join("\n"));
} finally {
  await rm(stage, { recursive: true, force: true });
}
