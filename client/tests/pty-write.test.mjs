import assert from "node:assert/strict";
import test from "node:test";

import {
  PTY_WRITE_CHUNK_SIZE,
  chunkPtyWrite,
} from "../dist-electron/pty-write.js";

test("short writes are returned as a single chunk", () => {
  assert.deepEqual(chunkPtyWrite("hello", 512), ["hello"]);
});

test("empty input yields no chunks", () => {
  assert.deepEqual(chunkPtyWrite("", 512), []);
});

test("long writes are split into chunks no larger than the size", () => {
  const data = "x".repeat(2000);
  const chunks = chunkPtyWrite(data, 512);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) assert.ok(chunk.length <= 512);
  assert.equal(chunks.join(""), data);
});

test("chunking preserves byte order exactly", () => {
  const data = "\x1b[200~" + "abcdefg ".repeat(500) + "\x1b[201~\r";
  assert.equal(chunkPtyWrite(data, 64).join(""), data);
});

test("surrogate pairs are never split across a chunk boundary", () => {
  // Each emoji is a surrogate pair (2 UTF-16 code units). With a chunk size
  // that would otherwise land mid-pair, the pair must move to the next chunk.
  const data = "😀".repeat(10);
  const chunks = chunkPtyWrite(data, 3);
  for (const chunk of chunks) {
    // No chunk should start or end on a lone surrogate.
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "chunk starts on low surrogate");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "chunk ends on high surrogate");
  }
  assert.equal(chunks.join(""), data);
});

test("a size of 1 still terminates on surrogate input", () => {
  const data = "😀a";
  const chunks = chunkPtyWrite(data, 1);
  assert.equal(chunks.join(""), data);
});

test("rejects a non-positive chunk size", () => {
  assert.throws(() => chunkPtyWrite("abc", 0), /chunk size must be positive/);
});

test("default chunk size is exported and positive", () => {
  assert.ok(PTY_WRITE_CHUNK_SIZE > 0);
  assert.equal(chunkPtyWrite("a".repeat(PTY_WRITE_CHUNK_SIZE)).length, 1);
  assert.equal(chunkPtyWrite("a".repeat(PTY_WRITE_CHUNK_SIZE + 1)).length, 2);
});
