import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
// The bundled CLI also exposes manual-contract helpers. Preserve their
// repository-relative resource resolution when Electron loads CommonJS.
const cliModuleURL = `const __crewvaneCliModuleURL = require("node:url").pathToFileURL(require("node:path").join(process.env.CREWVANE_KIT_ROOT ?? process.cwd(), "cli/src/bundle.ts")).href;`;
await build({
  entryPoints: ["electron/main.ts", "electron/utility.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "node-pty"],
  sourcemap: true,
  banner: { js: cliModuleURL },
  define: { "import.meta.url": "__crewvaneCliModuleURL" },
});
await build({
  entryPoints: ["electron/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
});
await viteBuild({
  root: ".",
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
  esbuild: { jsx: "automatic" },
});
