import assert from "node:assert/strict";
import test from "node:test";

import { nextAthenaLaunchState } from "../dist-electron/launch-state.js";

test("clean previous launch keeps terminal restore enabled", () => {
  const next = nextAthenaLaunchState({
    pid: 1,
    startedAt: "2026-05-25T00:00:00.000Z",
    cleanExit: true,
    terminalRestorePaused: false,
    previousCrashAt: null,
  }, 2, "2026-05-25T01:00:00.000Z");

  assert.equal(next.cleanExit, false);
  assert.equal(next.terminalRestorePaused, false);
  assert.equal(next.previousCrashAt, null);
});

test("unclean previous launch with a pending restore attempt pauses terminal restore", () => {
  const next = nextAthenaLaunchState({
    pid: 1,
    startedAt: "2026-05-25T00:00:00.000Z",
    cleanExit: false,
    terminalRestorePaused: false,
    previousCrashAt: null,
  }, 2, "2026-05-25T01:00:00.000Z", true);

  assert.equal(next.terminalRestorePaused, true);
  assert.equal(next.previousCrashAt, "2026-05-25T00:00:00.000Z");
});

test("unclean previous launch without a pending restore attempt keeps restore enabled", () => {
  const next = nextAthenaLaunchState({
    pid: 1,
    startedAt: "2026-05-25T00:00:00.000Z",
    cleanExit: false,
    terminalRestorePaused: false,
    previousCrashAt: null,
  }, 2, "2026-05-25T01:00:00.000Z", false);

  assert.equal(next.terminalRestorePaused, false);
  assert.equal(next.previousCrashAt, "2026-05-25T00:00:00.000Z");
});

test("pending restore attempt after a clean exit keeps restore enabled", () => {
  const next = nextAthenaLaunchState({
    pid: 1,
    startedAt: "2026-05-25T00:00:00.000Z",
    cleanExit: true,
    terminalRestorePaused: false,
    previousCrashAt: null,
  }, 2, "2026-05-25T01:00:00.000Z", true);

  assert.equal(next.terminalRestorePaused, false);
  assert.equal(next.previousCrashAt, null);
});

test("terminal restore pause persists until explicitly cleared", () => {
  const next = nextAthenaLaunchState({
    pid: 1,
    startedAt: "2026-05-25T00:00:00.000Z",
    cleanExit: true,
    terminalRestorePaused: true,
    previousCrashAt: "2026-05-24T00:00:00.000Z",
  }, 2, "2026-05-25T01:00:00.000Z");

  assert.equal(next.terminalRestorePaused, true);
  assert.equal(next.previousCrashAt, "2026-05-24T00:00:00.000Z");
});
