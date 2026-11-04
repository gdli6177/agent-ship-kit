import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareHerdr } from "../scripts/prepare-herdr.mjs";

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("version probing never mutates the supplied or cached Herdr binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-prepare-herdr-"));
  const source = join(root, "source-herdr");
  try {
    await writeFile(
      source,
      '#!/bin/sh\nprintf "# probe mutation\\n" >> "$0"\nprintf "herdr 9.9.9\\n"\n',
      { mode: 0o700 },
    );
    const expected = digest(await readFile(source));

    const cached = await prepareHerdr({
      CREWVANE_HERDR_BINARY: source,
      CREWVANE_HERDR_CACHE_DIR: join(root, "cache"),
    });

    assert.equal(digest(await readFile(source)), expected);
    assert.equal(digest(await readFile(cached)), expected);
  } finally {
    await chmod(source, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
