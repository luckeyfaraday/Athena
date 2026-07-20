import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMemorySnapshot,
  formatBytes,
  MEMORY_CRITICAL_BYTES,
  MEMORY_WARN_BYTES,
} from "../dist-electron/memory-guard.js";
import {
  HEAVY_LAUNCH_RESERVATION_BYTES,
  HEAVY_LAUNCH_STAGGER_MS,
  LaunchAdmissionService,
  launchStaggerDelayMs,
  OneShotLaunchOverride,
  publicLaunchAdmission,
} from "../dist-electron/launch-admission.js";

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

test("unused swap is not treated as physical launch capacity", () => {
  assert.equal(
    classifyMemorySnapshot({
      availableBytes: 1.5 * GiB,
      memFreeBytes: 256 * 1024 * 1024,
      swapTotalBytes: 8 * GiB,
      swapFreeBytes: 8 * GiB,
    }),
    "warn",
  );
  const service = new LaunchAdmissionService(() => memoryStatus("warn", 1.5 * GiB));
  const burst = service.reserve({ source: "control", kind: "codex", count: 2 });
  assert.equal(burst.granted, false);
  assert.equal(burst.decision, "defer");
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

function memoryStatus(level, availableBytes) {
  return { level, availableBytes, totalBytes: 16 * GiB };
}

test("launch admission atomically reserves a whole multi-agent request", () => {
  const service = new LaunchAdmissionService(() => memoryStatus("ok", 4 * GiB));
  const batch = service.reserve({ source: "control", kind: "codex", count: 4 });

  assert.equal(batch.decision, "warn");
  assert.equal(batch.granted, true);
  assert.equal(batch.requestedBytes, 4 * HEAVY_LAUNCH_RESERVATION_BYTES);
  assert.equal(batch.projectedAvailableBytes, 4 * GiB - 4 * HEAVY_LAUNCH_RESERVATION_BYTES);
  assert.equal(service.reservedBytes(), 4 * HEAVY_LAUNCH_RESERVATION_BYTES);

  const competing = service.reserve({ source: "control", kind: "claude", count: 3 });
  assert.equal(competing.decision, "defer");
  assert.equal(competing.granted, false);
  assert.equal(competing.alreadyReservedBytes, 4 * HEAVY_LAUNCH_RESERVATION_BYTES);
  assert.equal(service.reservationCount(), 1);
});

test("launch admission returns source-appropriate critical decisions", () => {
  const service = new LaunchAdmissionService(() => memoryStatus("critical", 900 * 1024 * 1024));
  const ui = service.reserve({ source: "ui", kind: "codex" });
  const control = service.reserve({ source: "control", kind: "codex" });
  const restore = service.reserve({ source: "restore", kind: "codex" });

  assert.equal(ui.decision, "reject");
  assert.equal(control.decision, "defer");
  assert.equal(restore.decision, "defer");
  assert.equal(ui.reservationId, null);
  assert.equal(service.reservationCount(), 0);
});

test("critical launch requires an explicit override and returns only a warning lease", () => {
  const service = new LaunchAdmissionService(() => memoryStatus("critical", 900 * 1024 * 1024));
  const admission = service.reserve({
    source: "control",
    kind: "athena",
    count: 2,
    overrideCritical: true,
  });

  assert.equal(admission.decision, "warn");
  assert.equal(admission.granted, true);
  assert.equal(admission.overrideUsed, true);
  assert.ok(admission.reservationId);
  assert.equal(publicLaunchAdmission(admission).reservationId, undefined);
});

test("release is idempotent and removes failed-spawn capacity reservations", () => {
  const service = new LaunchAdmissionService(() => memoryStatus("ok", 8 * GiB));
  const admission = service.reserve({ source: "control", kind: "grok", count: 2 });
  assert.equal(service.reservedBytes(), 2 * HEAVY_LAUNCH_RESERVATION_BYTES);
  assert.equal(service.release(admission), true);
  assert.equal(service.release(admission), false);
  assert.equal(service.reservedBytes(), 0);
});

test("settling a partial batch releases failed capacity and then expires", async () => {
  const service = new LaunchAdmissionService(() => memoryStatus("ok", 8 * GiB));
  const admission = service.reserve({ source: "control", kind: "codex", count: 4 });
  assert.equal(service.reservedBytes(), 4 * HEAVY_LAUNCH_RESERVATION_BYTES);

  assert.equal(service.settle(admission, 2, 10), true);
  assert.equal(service.reservedBytes(), 2 * HEAVY_LAUNCH_RESERVATION_BYTES);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.reservedBytes(), 0);
  assert.equal(service.reservationCount(), 0);
});

test("shell launches stay fail-open without consuming reservations", () => {
  const service = new LaunchAdmissionService(() => memoryStatus("critical", 0));
  const admission = service.reserve({ source: "control", kind: "shell", count: 8 });
  assert.equal(admission.decision, "allow");
  assert.equal(admission.granted, true);
  assert.equal(admission.requestedBytes, 0);
  assert.equal(admission.reservationId, null);
  assert.equal(service.reservedBytes(), 0);
});

test("heavy launch batches are staggered while recovery shells remain immediate", () => {
  assert.equal(launchStaggerDelayMs("codex", 0), 0);
  assert.equal(launchStaggerDelayMs("codex", 1), HEAVY_LAUNCH_STAGGER_MS);
  assert.equal(launchStaggerDelayMs("claude", 7), HEAVY_LAUNCH_STAGGER_MS);
  assert.equal(launchStaggerDelayMs("shell", 7), 0);
});

test("critical-memory UI approval authorizes one atomic request only", () => {
  const override = new OneShotLaunchOverride();
  override.grant(1_000, 5_000);
  assert.equal(override.consume(1_001), true);
  assert.equal(override.consume(1_002), false);

  override.grant(2_000, 5);
  assert.equal(override.consume(2_005), false);
});
