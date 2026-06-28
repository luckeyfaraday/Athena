import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMemorySnapshot,
  formatBytes,
  MEMORY_CRITICAL_BYTES,
  MEMORY_WARN_BYTES,
} from "../dist-electron/memory-guard.js";

const GiB = 1024 * 1024 * 1024;

const healthySwap = { swapTotalBytes: 2 * GiB, swapFreeBytes: 2 * GiB };

test("classifyMemorySnapshot flags critically low allocatable memory", () => {
  assert.equal(
    classifyMemorySnapshot({ availableBytes: 0, memFreeBytes: 0, ...healthySwap }),
    "critical",
  );
  assert.equal(
    classifyMemorySnapshot({ availableBytes: MEMORY_CRITICAL_BYTES - 1, memFreeBytes: 4 * GiB, ...healthySwap }),
    "critical",
  );
});

test("classifyMemorySnapshot treats saturated swap with little free RAM as critical", () => {
  // MemAvailable looks healthy (reclaimable cache) but the machine is thrashing:
  // this is the real shape of a busy agent fleet that froze the desktop.
  assert.equal(
    classifyMemorySnapshot({
      availableBytes: 4.7 * GiB,
      memFreeBytes: 300 * 1024 * 1024,
      swapTotalBytes: 2 * GiB,
      swapFreeBytes: 0,
    }),
    "critical",
  );
});

test("classifyMemorySnapshot warns between critical and warn thresholds", () => {
  assert.equal(
    classifyMemorySnapshot({ availableBytes: MEMORY_CRITICAL_BYTES, memFreeBytes: 2 * GiB, ...healthySwap }),
    "warn",
  );
  assert.equal(
    classifyMemorySnapshot({ availableBytes: MEMORY_WARN_BYTES - 1, memFreeBytes: 2 * GiB, ...healthySwap }),
    "warn",
  );
});

test("classifyMemorySnapshot warns when swap is half-gone and RAM is tight", () => {
  assert.equal(
    classifyMemorySnapshot({
      availableBytes: 4 * GiB,
      memFreeBytes: 2 * GiB,
      swapTotalBytes: 2 * GiB,
      swapFreeBytes: GiB, // 50% used
    }),
    "warn",
  );
});

test("classifyMemorySnapshot reports ok with ample memory and idle swap", () => {
  assert.equal(
    classifyMemorySnapshot({ availableBytes: 8 * GiB, memFreeBytes: 6 * GiB, ...healthySwap }),
    "ok",
  );
});

test("classifyMemorySnapshot never blocks a launch when the probe failed", () => {
  assert.equal(
    classifyMemorySnapshot({ availableBytes: null, memFreeBytes: null, swapTotalBytes: 0, swapFreeBytes: 0 }),
    "ok",
  );
});

test("formatBytes renders human-readable sizes", () => {
  assert.equal(formatBytes(null), "unknown");
  assert.equal(formatBytes(2 * GiB), "2.0 GiB");
});
