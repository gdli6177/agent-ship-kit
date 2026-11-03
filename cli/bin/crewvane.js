#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliTs = join(here, "..", "src", "cli.ts");
const require = createRequire(import.meta.url);

function resolveTsxCli() {
  const bases = [join(here, ".."), join(here, "..", "..")];
  for (const base of bases) {
    try {
      return require.resolve("tsx/cli", { paths: [base] });
    } catch {
      // Try the kit root when this file is installed under cli/bin.
    }
  }
  return null;
}

const tsxCli = resolveTsxCli();
if (tsxCli === null) {
  process.stderr.write(
    "crewvane: cannot find the tsx runtime. Re-run the installer, or run npm install in the kit directory.\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [tsxCli, cliTs, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`crewvane: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
