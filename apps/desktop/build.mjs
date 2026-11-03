import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["electron/main.ts", "electron/utility.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "node-pty"],
  sourcemap: true,
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
