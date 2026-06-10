import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFreeBytes,
  isEnospcError,
  formatBytes,
  DISK_CRITICAL_BYTES,
  DISK_WARN_BYTES,
} from "../dist-electron/disk-guard.js";

test("classifyFreeBytes flags critically low space", () => {
  assert.equal(classifyFreeBytes(0), "critical");
  assert.equal(classifyFreeBytes(DISK_CRITICAL_BYTES - 1), "critical");
});

test("classifyFreeBytes warns between critical and warn thresholds", () => {
  assert.equal(classifyFreeBytes(DISK_CRITICAL_BYTES), "warn");
  assert.equal(classifyFreeBytes(DISK_WARN_BYTES - 1), "warn");
});

test("classifyFreeBytes reports ok with ample space", () => {
  assert.equal(classifyFreeBytes(DISK_WARN_BYTES), "ok");
  assert.equal(classifyFreeBytes(50 * 1024 * 1024 * 1024), "ok");
});

test("classifyFreeBytes never blocks startup when the probe failed", () => {
  assert.equal(classifyFreeBytes(null), "ok");
});

test("isEnospcError detects ENOSPC and ignores others", () => {
  assert.equal(isEnospcError(Object.assign(new Error("full"), { code: "ENOSPC" })), true);
  assert.equal(isEnospcError(Object.assign(new Error("perm"), { code: "EACCES" })), false);
  assert.equal(isEnospcError(new Error("plain")), false);
  assert.equal(isEnospcError(null), false);
});

test("formatBytes renders human-readable sizes", () => {
  assert.equal(formatBytes(null), "unknown");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GiB");
});
