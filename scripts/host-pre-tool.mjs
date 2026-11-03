// Host adapter entry: normalized { tool:'shell', argv:[...] } or { tool:'read'|'write', path, content? } on stdin.
// The trusted host binds CREWVANE_ACTOR; never let model-supplied tool args select that identity.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli/bin/crewvane.js", import.meta.url));
const child = spawn(process.execPath, [cli, "guard", "tool", "--input", "-", ...process.argv.slice(2)], { stdio: ["pipe", "inherit", "inherit"] });
process.stdin.pipe(child.stdin);
child.on("error", () => { process.stderr.write("crewvane host guard failed to start; tool must be blocked\n"); process.exitCode = 2; });
child.on("exit", code => { process.exitCode = code === 0 ? 0 : 2; });
