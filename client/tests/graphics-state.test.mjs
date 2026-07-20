import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseGraphicsMode,
  initializeOwnedGraphicsLaunch,
  isGpuFailureReason,
  parseGraphicsPreference,
} from "../dist-electron/graphics-state.js";

const cleanState = {
  version: 1,
  quarantined: false,
  acceleratedClean: true,
  acceleratedPending: false,
  lastMode: "accelerated",
  lastGpuCrashAt: null,
  lastGpuCrashReason: null,
  lastCleanAt: "2026-07-20T00:00:00.000Z",
};

test("Linux auto mode canaries acceleration and retains a clean record", () => {
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: { ...cleanState, acceleratedClean: false } }).mode, "accelerated");
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "auto", state: cleanState }).mode, "accelerated");
});

test("a GPU crash quarantines preference-based acceleration but not an environment override", () => {
  const crashed = { ...cleanState, quarantined: true, acceleratedClean: false };
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: crashed }).mode, "safe");
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: crashed, forceGpu: true }).mode, "accelerated");
});

test("an interrupted accelerated launch is crash-loop quarantined", () => {
  const interrupted = { ...cleanState, acceleratedPending: true };
  const decision = chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: interrupted });
  assert.equal(decision.mode, "safe");
  assert.equal(decision.quarantined, true);
  assert.match(decision.reason, /did not exit cleanly/);
});

test("headless safety wins unless GPU is explicitly forced", () => {
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "accelerated", state: cleanState, headless: true }).mode, "safe");
  assert.equal(chooseGraphicsMode({ platform: "linux", preference: "safe", state: cleanState, headless: true, forceGpu: true }).mode, "accelerated");
  assert.equal(parseGraphicsPreference("unknown"), "auto");
});

test("explicit safe mode and crash quarantine work on Windows and macOS", () => {
  assert.equal(chooseGraphicsMode({ platform: "win32", preference: "safe", state: cleanState }).mode, "safe");
  assert.equal(chooseGraphicsMode({ platform: "darwin", preference: "safe", state: cleanState }).mode, "safe");
  assert.equal(
    chooseGraphicsMode({ platform: "win32", preference: "auto", state: { ...cleanState, quarantined: true } }).mode,
    "safe",
  );
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
