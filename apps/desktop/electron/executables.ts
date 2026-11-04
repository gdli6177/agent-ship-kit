import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

// Finder does not inherit the PATH from an interactive terminal. Read only the
// shell's PATH, once, and keep its other environment/configuration out of logs.
export class Executables {
  private directories?: Promise<string[]>;
  constructor(readonly home: string, readonly managedBin: string,
    readonly env = process.env, readonly isolated = false) {}
  async paths() {
    return this.directories ??= (async () => {
      let shellPath = "";
      if (!this.isolated) {
        try {
          const { stdout } = await exec(this.env.SHELL || "/bin/zsh", [
            "-ilc", 'printf "\\n__CREWVANE_PATH__%s\\n" "$PATH"',
          ], { env: this.env, timeout: 5_000, maxBuffer: 256_000 });
          shellPath = stdout.split("__CREWVANE_PATH__").at(-1)?.split(/\r?\n/)[0] ?? "";
        } catch { /* fixed locations and inherited PATH remain available */ }
      }
      return [...new Set([
        this.managedBin, join(this.home, ".local/bin"), join(this.home, "bin"),
        ...shellPath.split(delimiter), ...(this.env.PATH ?? "").split(delimiter),
        ...(!this.isolated ? [join(this.home, ".cargo/bin"), join(this.home, "Library/pnpm"),
          "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] : []),
      ].filter(path => isAbsolute(path)))];
    })();
  }
  async find(command: string, cwd?: string) {
    const expanded = command.startsWith("~/") ? join(this.home, command.slice(2)) : command;
    const candidates = isAbsolute(expanded) ? [expanded] : expanded.includes("/") && cwd
      ? [join(cwd, expanded)] : (await this.paths()).map(dir => join(dir, expanded));
    for (const path of candidates) {
      try {
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch { /* unavailable, broken symlink or next candidate */ }
    }
  }
}
