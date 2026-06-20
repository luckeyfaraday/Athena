import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mapWithConcurrency, readFilePrefix } from "../dist-electron/file-prefix.js";

test("readFilePrefix does not materialize the full file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-prefix-"));
  const filePath = path.join(directory, "large.jsonl");
  fs.writeFileSync(filePath, `${"a".repeat(1_000_000)}\ntrailing`);
  try {
    const prefix = await readFilePrefix(filePath, 4_096);
    assert.equal(Buffer.byteLength(prefix), 4_096);
    assert.equal(prefix, "a".repeat(4_096));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mapWithConcurrency preserves order and bounds active workers", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
});
