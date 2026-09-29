import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_ATTENTION_SCAN_MAX_CHARS,
  TERMINAL_ATTENTION_THROTTLE_MS,
  TerminalAttentionTracker,
  classifyTerminalAttention,
} from "../dist-electron/terminal-attention.js";

test("main-side attention classification replaces global raw renderer output", () => {
  assert.equal(classifyTerminalAttention("Waiting for approval to run command"), "action");
  assert.equal(classifyTerminalAttention("Task complete. Ready for review."), "update");
  assert.equal(classifyTerminalAttention("transforming modules...".repeat(4_000)), null);
});

test("attention classification carries only a bounded suffix across split PTY batches", () => {
  const tracker = new TerminalAttentionTracker();
  assert.equal(tracker.classify("one", "Waiting for appr"), null);
  assert.equal(tracker.classify("one", "oval to continue"), "action");
  tracker.clear("one");
  assert.equal(tracker.classify("one", "ordinary output"), null);
});

function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, dueAt: now + delayMs });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle),
    pendingTimers: () => timers.size,
    // Fire due timers in deadline order, each at its own due time.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [handle, timer] of timers) {
          if (timer.dueAt <= target && (!next || timer.dueAt < next[1].dueAt)) next = [handle, timer];
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
      }
      now = target;
    },
  };
}

function throttledTracker() {
  const clock = fakeClock();
  const reports = [];
  const tracker = new TerminalAttentionTracker(
    (id, kind) => reports.push({ id, kind, at: clock.now() }),
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  return { clock, reports, tracker };
}

test("attention scans are throttled per terminal with a trailing check", () => {
  const { clock, reports, tracker } = throttledTracker();
  tracker.observe("t", "Task complete. Ready for review.");
  assert.deepEqual(reports, [{ id: "t", kind: "update", at: 0 }], "leading chunk is scanned immediately");

  // A burst of batches inside the throttle window is not scanned per batch...
  for (let index = 1; index <= 20; index += 1) {
    clock.advance(10);
    tracker.observe("t", index === 7 ? "Waiting for approval to continue\r\n" : `build step ${index} done\r\n`);
  }
  assert.equal(reports.length, 1);
  assert.equal(clock.pendingTimers(), 1, "exactly one trailing scan is armed");

  // ...but the trailing scan covers everything that arrived in the window.
  clock.advance(TERMINAL_ATTENTION_THROTTLE_MS);
  assert.deepEqual(reports.at(-1), { id: "t", kind: "action", at: TERMINAL_ATTENTION_THROTTLE_MS });
  assert.equal(reports.length, 2);
});

test("a cue arriving late in a quiet window is still reported by the trailing scan", () => {
  const { clock, reports, tracker } = throttledTracker();
  tracker.observe("t", "ordinary output\r\n");
  assert.equal(reports.length, 0);
  clock.advance(100);
  tracker.observe("t", "Waiting for appr");
  clock.advance(20);
  tracker.observe("t", "oval to continue");
  assert.equal(reports.length, 0, "no scan inside the throttle window");
  clock.advance(TERMINAL_ATTENTION_THROTTLE_MS);
  assert.deepEqual(reports, [{ id: "t", kind: "action", at: TERMINAL_ATTENTION_THROTTLE_MS }]);
});

test("attention throttling is independent per terminal and cleared terminals stop scanning", () => {
  const { clock, reports, tracker } = throttledTracker();
  tracker.observe("one", "plain");
  tracker.observe("two", "Task complete. Ready for review.");
  assert.deepEqual(reports.map((report) => report.id), ["two"]);
  clock.advance(10);
  tracker.observe("one", "Waiting for approval to continue");
  tracker.clear("one");
  assert.equal(clock.pendingTimers(), 0, "clear cancels the trailing scan");
  clock.advance(TERMINAL_ATTENTION_THROTTLE_MS);
  assert.deepEqual(reports.map((report) => report.id), ["two"]);
});

test("throttled attention scans only the bounded newest window of large output", () => {
  const { reports, tracker } = throttledTracker();
  tracker.observe("t", `approval required ${"x".repeat(TERMINAL_ATTENTION_SCAN_MAX_CHARS * 3)}`);
  assert.equal(reports.length, 0, "a cue outside the scan window is ignored");
});
