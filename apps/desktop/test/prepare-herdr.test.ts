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

test("authenticated release downloads keep digest and version verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-prepare-herdr-auth-"));
  const originalFetch = globalThis.fetch;
  const target = process.platform === "darwin"
    ? `macos-${process.arch === "arm64" ? "aarch64" : "x86_64"}`
    : `${process.platform}-${process.arch === "x64" ? "x86_64" : process.arch}`;
  const assetUrl = "https://api.github.test/assets/herdr";
  const bytes = Buffer.from('#!/bin/sh\nprintf "herdr 1.2.3\\n"\n');
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url === "https://api.github.com/repos/herdrdev/herdr/releases/latest")
      return Response.json({
        tag_name: "v1.2.3",
        assets: [{
          name: `herdr-${target}`,
          url: assetUrl,
          digest: `sha256:${digest(bytes)}`,
        }],
      });
    if (url === assetUrl)
      return new Response(bytes, { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    const cached = await prepareHerdr({
      GITHUB_TOKEN: "test-token",
      CREWVANE_HERDR_CACHE_DIR: join(root, "cache"),
    });

    assert.deepEqual(await readFile(cached), bytes);
    assert.deepEqual(
      calls.map(({ url, authorization }) => ({ url, authorization })),
      [
        {
          url: "https://api.github.com/repos/herdrdev/herdr/releases/latest",
          authorization: "Bearer test-token",
        },
        { url: assetUrl, authorization: "Bearer test-token" },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
