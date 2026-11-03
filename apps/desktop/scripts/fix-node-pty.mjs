import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url),
  packagePath = require.resolve("node-pty/package.json"),
  root = dirname(packagePath);

// pnpm can preserve the prebuilt spawn helper without its executable bit.
// node-pty otherwise fails with the opaque "posix_spawnp failed" error.
for (const path of [
  join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  join(root, "build", "Release", "spawn-helper"),
]) {
  await chmod(path, 0o755).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
