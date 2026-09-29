import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseGraphicsMode,
  cleanExitGraphicsState,
  GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES,
  GRAPHICS_QUARANTINE_MAX_AGE_MS,
  GRAPHICS_RETRY_CONFIRM_LAUNCHES,
  gpuCrashGraphicsState,
  graphicsQuarantineLimits,
  initializeOwnedGraphicsLaunch,
  isGpuFailureReason,
  isGraphicsQuarantineActive,
  nextLaunchGraphicsState,
  normalizeGraphicsState,
  parseGraphicsPreference,
} from "../dist-electron/graphics-state.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const cleanState = {
  version: 1,
  quarantined: false,
  quarantinedAt: null,
  safeCleanLaunches: 0,
  uncleanAcceleratedExits: 0,
  quarantineCount: 0,
  retrying: false,
  acceleratedCleanStreak: 0,
  acceleratedClean: true,
  acceleratedPending: false,
  lastMode: "accelerated",
  lastGpuCrashAt: null,
  lastGpuCrashReason: null,
  lastCleanAt: "2026-07-20T00:00:00.000Z",
};

const recentQuarantine = {
  ...cleanState,
  quarantined: true,
  quarantinedAt: new Date(NOW - HOUR).toISOString(),
  quarantineCount: 1,
  acceleratedClean: false,
  lastMode: "safe",
  lastGpuCrashAt: new Date(NOW - HOUR).toISOString(),
  lastGpuCrashReason: "crashed (exit 139)",
};

test("Linux auto mode canaries acceleration and retains a clean record", () => {
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: { ...cleanState, acceleratedClean: false }, now: NOW }).mode, "accelerated");
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: cleanState, now: NOW }).mode, "accelerated");
});

test("a Linux GPU crash quarantines preference-based acceleration but not an environment override", () => {
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: recentQuarantine, now: NOW }).mode, "safe");
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: recentQuarantine, now: NOW }).quarantined, true);
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: recentQuarantine, forceGpu: true, now: NOW }).mode, "accelerated");
});

test("a single unclean accelerated exit is not treated as a GPU crash", () => {
  const interrupted = { ...cleanState, acceleratedPending: true };
  const decision = chooseGraphicsMode({ platform: "linux", preference: "auto", state: interrupted, now: NOW });
  assert.equal(decision.mode, "accelerated");
  assert.equal(decision.quarantined, false);

  const next = nextLaunchGraphicsState(interrupted, decision, "linux", new Date(NOW));
  assert.equal(next.quarantined, false);
  assert.equal(next.uncleanAcceleratedExits, 1);
  assert.equal(next.acceleratedPending, true);
});

test("repeated unclean accelerated exits on Linux are crash-loop quarantined", () => {
  const looping = { ...cleanState, acceleratedPending: true, uncleanAcceleratedExits: 1 };
  const decision = chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: looping, now: NOW });
  assert.equal(decision.mode, "safe");
  assert.equal(decision.quarantined, true);
  assert.match(decision.reason, /did not exit cleanly/);

  const next = nextLaunchGraphicsState(looping, decision, "linux", new Date(NOW));
  assert.equal(next.quarantined, true);
  assert.equal(next.quarantinedAt, new Date(NOW).toISOString());
  assert.equal(next.acceleratedPending, false);
  assert.equal(isGraphicsQuarantineActive(next, "linux", NOW), true);
});

test("a clean accelerated exit resets the unclean-exit run", () => {
  const next = cleanExitGraphicsState({ ...cleanState, acceleratedPending: true, uncleanAcceleratedExits: 1 }, "accelerated", new Date(NOW));
  assert.equal(next.uncleanAcceleratedExits, 0);
  assert.equal(next.acceleratedPending, false);
  assert.equal(next.acceleratedClean, true);
});

test("Linux GPU-process crashes quarantine; other platforms only record diagnostics", () => {
  const linux = gpuCrashGraphicsState(cleanState, "crashed (exit 139)", "linux", new Date(NOW));
  assert.equal(linux.quarantined, true);
  assert.equal(linux.quarantinedAt, new Date(NOW).toISOString());
  assert.equal(linux.safeCleanLaunches, 0);

  for (const platform of ["win32", "darwin"]) {
    const other = gpuCrashGraphicsState(cleanState, "crashed", platform, new Date(NOW));
    assert.equal(other.quarantined, false);
    assert.equal(other.lastGpuCrashReason, "crashed");
  }
});

test("quarantine expires after enough clean safe-mode launches", () => {
  let state = recentQuarantine;
  for (let launch = 0; launch < GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES; launch += 1) {
    const decision = chooseGraphicsMode({ platform: "linux", preference: "auto", state, now: NOW });
    assert.equal(decision.mode, "safe", `launch ${launch} should still be quarantined`);
    state = nextLaunchGraphicsState(state, decision, "linux", new Date(NOW));
    state = cleanExitGraphicsState(state, decision.mode, new Date(NOW));
  }
  assert.equal(state.safeCleanLaunches, GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES);

  const retry = chooseGraphicsMode({ platform: "linux", preference: "auto", state, now: NOW });
  assert.equal(retry.mode, "accelerated");
  assert.match(retry.reason, /expired/);
  const launched = nextLaunchGraphicsState(state, retry, "linux", new Date(NOW));
  assert.equal(launched.quarantined, false);
  assert.equal(launched.acceleratedPending, true);
  assert.equal(launched.retrying, true);
});

test("quarantine expires after its maximum age", () => {
  const later = NOW + GRAPHICS_QUARANTINE_MAX_AGE_MS;
  assert.equal(isGraphicsQuarantineActive(recentQuarantine, "linux", NOW), true);
  assert.equal(isGraphicsQuarantineActive(recentQuarantine, "linux", later), false);
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: recentQuarantine, now: later }).mode, "accelerated");
});

test("a legacy quarantine without a start time falls back to the crash time", () => {
  const legacy = {
    ...cleanState,
    quarantined: true,
    quarantinedAt: undefined,
    safeCleanLaunches: undefined,
    lastMode: "safe",
    lastGpuCrashAt: "2026-08-29T10:00:00.000Z",
  };
  assert.equal(isGraphicsQuarantineActive(legacy, "linux", Date.parse("2026-08-30T10:00:00.000Z")), true);
  assert.equal(isGraphicsQuarantineActive(legacy, "linux", NOW), false);
  assert.equal(isGraphicsQuarantineActive({ ...legacy, lastGpuCrashAt: null }, "linux", NOW), false);
});

test("a retry that GPU-crashes again re-quarantines with a doubled window", () => {
  const expired = { ...recentQuarantine, safeCleanLaunches: GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES };
  const retry = chooseGraphicsMode({ platform: "linux", preference: "auto", state: expired, now: NOW });
  const launched = nextLaunchGraphicsState(expired, retry, "linux", new Date(NOW));
  const crashed = gpuCrashGraphicsState(launched, "crashed", "linux", new Date(NOW + HOUR));
  assert.equal(crashed.safeCleanLaunches, 0);
  assert.equal(crashed.quarantineCount, 2);
  assert.equal(crashed.retrying, false);
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: crashed, now: NOW + 2 * HOUR }).mode, "safe");
  // The first quarantine's limits no longer release it.
  const afterFirstLimits = { ...crashed, safeCleanLaunches: GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES };
  assert.equal(isGraphicsQuarantineActive(afterFirstLimits, "linux", NOW + GRAPHICS_QUARANTINE_MAX_AGE_MS), true);
});

test("a post-expiry retry re-quarantines on the first unclean accelerated exit", () => {
  const expired = { ...recentQuarantine, safeCleanLaunches: GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES };
  const retry = chooseGraphicsMode({ platform: "linux", preference: "auto", state: expired, now: NOW });
  const launched = nextLaunchGraphicsState(expired, retry, "linux", new Date(NOW));
  assert.equal(launched.retrying, true);

  // The retry process dies without an orderly shutdown (acceleratedPending stays set).
  const decision = chooseGraphicsMode({ platform: "linux", preference: "auto", state: launched, now: NOW + HOUR });
  assert.equal(decision.mode, "safe");
  assert.equal(decision.quarantined, true);
  assert.match(decision.reason, /retry/);
  const requarantined = nextLaunchGraphicsState(launched, decision, "linux", new Date(NOW + HOUR));
  assert.equal(requarantined.quarantined, true);
  assert.equal(requarantined.quarantineCount, 2);
  assert.equal(requarantined.retrying, false);
  assert.equal(requarantined.acceleratedPending, false);
});

test("each re-quarantine doubles the backoff up to a cap", () => {
  const day = 24 * HOUR;
  assert.deepEqual(graphicsQuarantineLimits(1), { cleanSafeLaunches: 3, maxAgeMs: 7 * day });
  assert.deepEqual(graphicsQuarantineLimits(2), { cleanSafeLaunches: 6, maxAgeMs: 14 * day });
  assert.deepEqual(graphicsQuarantineLimits(3), { cleanSafeLaunches: 12, maxAgeMs: 28 * day });
  assert.deepEqual(graphicsQuarantineLimits(4), { cleanSafeLaunches: 24, maxAgeMs: 56 * day });
  assert.deepEqual(graphicsQuarantineLimits(20), graphicsQuarantineLimits(4));
});

test("a machine whose accelerated launches always die spends almost every launch in safe mode", () => {
  // Every accelerated launch ends in a native crash (no orderly shutdown);
  // every safe launch exits cleanly. One launch per hour, so only the
  // clean-launch limits (not the age limits) release a quarantine.
  let state = { ...cleanState, acceleratedClean: false };
  let acceleratedLaunches = 0;
  for (let launch = 0; launch < 100; launch += 1) {
    const now = NOW + launch * HOUR;
    const decision = chooseGraphicsMode({ platform: "linux", preference: "auto", state, now });
    state = nextLaunchGraphicsState(state, decision, "linux", new Date(now));
    if (decision.mode === "accelerated") acceleratedLaunches += 1;
    else state = cleanExitGraphicsState(state, "safe", new Date(now));
  }
  // 2 canary crashes, then one crash per (3, 6, 12, 24, 24, ...) safe launches.
  assert.ok(acceleratedLaunches <= 8, `crashed ${acceleratedLaunches} times in 100 launches`);
});

test("a retry proven by clean accelerated launches resets the backoff", () => {
  let state = { ...cleanState, quarantineCount: 3, retrying: true };
  for (let launch = 0; launch < GRAPHICS_RETRY_CONFIRM_LAUNCHES; launch += 1) {
    assert.equal(state.retrying, true);
    const decision = chooseGraphicsMode({ platform: "linux", preference: "auto", state, now: NOW });
    assert.equal(decision.mode, "accelerated");
    state = nextLaunchGraphicsState(state, decision, "linux", new Date(NOW));
    state = cleanExitGraphicsState(state, "accelerated", new Date(NOW));
  }
  assert.equal(state.retrying, false);
  assert.equal(state.quarantineCount, 0);

  // Back to the healthy-machine budget: one unclean exit is forgiven.
  const decision = chooseGraphicsMode({ platform: "linux", preference: "auto", state, now: NOW });
  const launched = nextLaunchGraphicsState(state, decision, "linux", new Date(NOW));
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: launched, now: NOW + HOUR }).mode, "accelerated");
});

test("legacy state files with GPU crash history count as one prior quarantine", () => {
  const legacyQuarantine = normalizeGraphicsState({
    version: 1,
    quarantined: true,
    acceleratedClean: false,
    acceleratedPending: false,
    lastMode: "safe",
    lastGpuCrashAt: "2026-08-29T12:02:29.692Z",
    lastGpuCrashReason: "Previous accelerated Athena launch did not exit cleanly.",
    lastCleanAt: "2026-09-27T21:15:08.033Z",
  });
  assert.equal(legacyQuarantine.quarantineCount, 1);
  // Its quarantine has long expired: retry acceleration, strictly.
  const retry = chooseGraphicsMode({ platform: "linux", preference: "auto", state: legacyQuarantine, now: NOW });
  assert.equal(retry.mode, "accelerated");
  const launched = nextLaunchGraphicsState(legacyQuarantine, retry, "linux", new Date(NOW));
  assert.equal(launched.retrying, true);
  const afterCrash = chooseGraphicsMode({ platform: "linux", preference: "auto", state: launched, now: NOW + HOUR });
  assert.equal(afterCrash.mode, "safe");
  assert.equal(nextLaunchGraphicsState(launched, afterCrash, "linux", new Date(NOW + HOUR)).quarantineCount, 2);

  // Crash history without an active quarantine is already a retry.
  const legacyRecovered = normalizeGraphicsState({ ...legacyQuarantine, quarantineCount: undefined, retrying: undefined, quarantined: false });
  assert.equal(legacyRecovered.quarantineCount, 1);
  assert.equal(legacyRecovered.retrying, true);

  // No crash history: the ordinary two-unclean-exit budget.
  const legacyHealthy = normalizeGraphicsState({ version: 1, quarantined: false, acceleratedClean: true, acceleratedPending: false, lastMode: "accelerated", lastGpuCrashAt: null, lastGpuCrashReason: null, lastCleanAt: null });
  assert.equal(legacyHealthy.quarantineCount, 0);
  assert.equal(legacyHealthy.retrying, false);

  // Current-format files keep their recorded values.
  const current = normalizeGraphicsState({ ...cleanState, lastGpuCrashAt: "2026-08-29T12:02:29.692Z" });
  assert.equal(current.quarantineCount, 0);
  assert.equal(current.retrying, false);
});

test("Windows and macOS auto mode is always accelerated and ignores stale quarantine", () => {
  const stale = { ...recentQuarantine, acceleratedPending: true, uncleanAcceleratedExits: 5 };
  for (const platform of ["win32", "darwin"]) {
    const decision = chooseGraphicsMode({ platform, preference: "auto", state: stale, now: NOW });
    assert.equal(decision.mode, "accelerated");
    assert.equal(decision.quarantined, false);
    assert.equal(chooseGraphicsMode({ platform, preference: "accelerated", state: stale, now: NOW }).mode, "accelerated");
    assert.equal(isGraphicsQuarantineActive(stale, platform, NOW), false);

    const next = nextLaunchGraphicsState({ ...stale, quarantineCount: 4, retrying: true }, decision, platform, new Date(NOW));
    assert.equal(next.quarantined, false);
    assert.equal(next.acceleratedPending, false);
    assert.equal(next.uncleanAcceleratedExits, 0);
    assert.equal(next.quarantineCount, 0);
    assert.equal(next.retrying, false);
  }
});

test("the incident state from a sticky Windows quarantine recovers acceleration", () => {
  const incident = {
    version: 1,
    quarantined: true,
    acceleratedClean: false,
    acceleratedPending: false,
    lastMode: "safe",
    lastGpuCrashAt: "2026-08-29T08:00:00.000Z",
    lastGpuCrashReason: "Previous accelerated Athena launch did not exit cleanly.",
    lastCleanAt: "2026-09-28T08:00:00.000Z",
  };
  const normalized = normalizeGraphicsState(incident);
  const decision = chooseGraphicsMode({ platform: "win32", preference: "auto", state: normalized, now: NOW });
  assert.equal(decision.mode, "accelerated");
  const next = nextLaunchGraphicsState(normalized, decision, "win32", new Date(NOW));
  assert.equal(next.quarantined, false);
  assert.equal(next.lastGpuCrashReason, null);
});

test("explicit safe mode works on every platform", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.equal(chooseGraphicsMode({ platform, preference: "safe", state: cleanState, now: NOW }).mode, "safe");
  }
  assert.equal(chooseGraphicsMode({ platform: "win32", preference: "auto", state: cleanState, forceSafe: true, now: NOW }).mode, "safe");
});

test("headless safety wins unless GPU is explicitly forced", () => {
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: cleanState, headless: true, now: NOW }).mode, "safe");
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "safe", state: cleanState, headless: true, forceGpu: true, now: NOW }).mode, "accelerated");
  assert.equal(parseGraphicsPreference("unknown"), "auto");
});

test("clean safe-mode exits only count toward expiry while quarantined", () => {
  assert.equal(cleanExitGraphicsState(cleanState, "safe", new Date(NOW)).safeCleanLaunches, 0);
  assert.equal(cleanExitGraphicsState(recentQuarantine, "safe", new Date(NOW)).safeCleanLaunches, 1);
  assert.equal(cleanExitGraphicsState(recentQuarantine, "accelerated", new Date(NOW)).quarantined, false);
});

test("normal GPU teardown is not mistaken for a graphics crash", () => {
  assert.equal(isGpuFailureReason("clean-exit"), false);
  assert.equal(isGpuFailureReason("killed"), false);
  assert.equal(isGpuFailureReason("crashed"), true);
  assert.equal(isGpuFailureReason("oom"), true);
});

test("a packaged second instance cannot mutate the primary graphics launch state", () => {
  let initialized = 0;
  assert.equal(initializeOwnedGraphicsLaunch(false, () => { initialized += 1; }), false);
  assert.equal(initialized, 0);
  assert.equal(initializeOwnedGraphicsLaunch(true, () => { initialized += 1; }), true);
  assert.equal(initialized, 1);
});
