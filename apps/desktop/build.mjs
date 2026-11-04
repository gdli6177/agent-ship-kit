import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["electron/main.ts", "electron/preload.ts", "electron/terminal-worker.ts"], bundle: true, platform: "node", format: "cjs", outdir: "dist", outExtension: { ".js": ".cjs" }, external: ["electron", "node-pty"], sourcemap: true });
await build({ entryPoints: ["../../cli/src/main.ts"], bundle: true, platform: "node", format: "cjs", target: "node20", outfile: "dist/cli/crewvane.cjs" });
await cp("assets/brand/crewvane-icon.png", "dist/assets/crewvane-icon.png");
await viteBuild({ root: ".", base: "./", build: { outDir: "dist/renderer", emptyOutDir: true }, esbuild: { jsx: "automatic" } });
