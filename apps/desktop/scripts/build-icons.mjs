import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const brand = fileURLToPath(new URL("../assets/brand/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "crewvane-icons-"));
try {
  const iconset = join(temporary, "Crewvane.iconset");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(iconset);
  // Use the dedicated macOS composition; never put the full scene in the Dock.
  await exec("sips", ["-z", "1024", "1024", join(brand, "crewvane-macos-source.png"),
    "--out", join(brand, "crewvane-icon.png")]);
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      await exec("sips", ["-z", String(pixels), String(pixels),
        join(brand, "crewvane-icon.png"), "--out",
        join(iconset, `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`)]);
    }
  }
  await exec("iconutil", ["-c", "icns", iconset, "-o", join(brand, "crewvane-icon.icns")]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
