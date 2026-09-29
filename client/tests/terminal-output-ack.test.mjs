import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OUTPUT_ACK_TIMEOUT_MS,
  OutputAckGate,
} from "../dist-electron/terminal-output-ack.js";
import {
  DEFAULT_CONSUMER_RESET_BACKLOG_CHARS,
  TerminalFlowController,
  TerminalOutputStreamHub,
} from "../dist-electron/terminal-output-stream.js";
import {
  DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_OUTPUT_TRUNCATED_NOTICE,
  TerminalOutputBatcher,
} from "../dist-electron/terminal-buffer.js";
import { PtyFlowGate, afterOutputQuiet, ptyFlowControlSupported } from "../dist-electron/pty-host-protocol.js";
import { PtyHostClient } from "../dist-electron/pty-host-client.js";
import {
  TERMINAL_OUTPUT_CLEANUP_INTERVAL_MS,
  TERMINAL_OUTPUT_MAX_GRACE_MS,
  terminalOutputCleanupDecision,
} from "../dist-electron/terminal-output-cleanup.js";

function batch(overrides = {}) {
  return {
    epoch: "epoch-1",
    fromSequence: 1,
    sequence: 1,
    data: "one",
    reset: false,
    ...overrides,
  };
}

test("retains one batch until a matching epoch/sequence is acknowledged", () => {
  const gate = new OutputAckGate(1000);
  const output = batch();
  assert.equal(gate.canSend("consumer"), true);
  gate.markSent("consumer", output, 0);
  assert.equal(gate.canSend("consumer"), false);
  assert.equal(gate.current("consumer"), output);
  assert.equal(gate.acknowledge("consumer", output.epoch, output.sequence), true);
  assert.equal(gate.canSend("consumer"), true);
});

test("stale, wrong-epoch and duplicate ACKs cannot clear a fresh batch", () => {
  const gate = new OutputAckGate(1000);
  const output = batch({ epoch: "fresh", sequence: 8 });
  gate.markSent("consumer", output, 0);
  assert.equal(gate.acknowledge("consumer", "old", 8), false);
  assert.equal(gate.acknowledge("consumer", "fresh", 7), false);
  assert.equal(gate.canSend("consumer"), false);
  assert.equal(gate.acknowledge("consumer", "fresh", 8), true);
  assert.equal(gate.acknowledge("consumer", "fresh", 8), false);
});

test("timeout retries the exact retained payload and restarts its deadline", () => {
  const gate = new OutputAckGate(2000);
  const output = batch({ data: "must-not-be-lost" });
  gate.markSent("consumer", output, 1000);
  assert.equal(gate.retry("consumer", 2999), null);
  assert.equal(gate.retryDelayMs("consumer", 2999), 1);
  assert.equal(gate.retry("consumer", 3000), output);
  assert.equal(gate.retry("consumer", 3001), null, "retry deadline was restarted");
  assert.equal(gate.retryDelayMs("consumer", 3001), 1999);
});

test("clearing/rebasing a consumer makes a late ACK harmless", () => {
  const gate = new OutputAckGate(1000);
  const old = batch({ epoch: "old", sequence: 2 });
  gate.markSent("consumer", old, 0);
  gate.clear("consumer");
  const fresh = batch({ epoch: "fresh", sequence: 9 });
  gate.markSent("consumer", fresh, 1);
  assert.equal(gate.acknowledge("consumer", old.epoch, old.sequence), false);
  assert.equal(gate.current("consumer"), fresh);
});

test("exposes a positive default ack timeout", () => {
  assert.equal(typeof DEFAULT_OUTPUT_ACK_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_OUTPUT_ACK_TIMEOUT_MS > 0);
});

test("exit tombstones extend for pending drains but clear at a hard deadline", () => {
  const startedAt = 1_000;
  const deadline = startedAt + TERMINAL_OUTPUT_MAX_GRACE_MS;
  assert.deepEqual(
    terminalOutputCleanupDecision(startedAt, deadline, false),
    { clear: true, delayMs: 0 },
  );
  assert.deepEqual(
    terminalOutputCleanupDecision(startedAt, deadline, true),
    { clear: false, delayMs: TERMINAL_OUTPUT_CLEANUP_INTERVAL_MS },
  );
  assert.deepEqual(
    terminalOutputCleanupDecision(deadline - 7, deadline, true),
    { clear: false, delayMs: 7 },
  );
  assert.deepEqual(
    terminalOutputCleanupDecision(deadline, deadline, true),
    { clear: true, delayMs: 0 },
  );
});

test("versioned attach snapshots output atomically before later live sequences", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 1000 });
  hub.append("terminal", "before attach\r\n");
  hub.subscribe("terminal", "renderer");
  hub.append("terminal", "between subscribe and snapshot\r\n");
  const snapshot = hub.attach("terminal", "renderer");
  assert.deepEqual(snapshot, {
    id: "terminal",
    epoch: "epoch",
    buffer: "before attach\r\nbetween subscribe and snapshot\r\n",
    throughSequence: 2,
  });

  hub.append("terminal", "after attach\r\n");
  const [delivery] = hub.poll(0);
  assert.equal(delivery.fromSequence, 3);
  assert.equal(delivery.sequence, 3);
  assert.equal(delivery.data, "after attach\r\n");
});

test("a paused control attach cannot lose output produced between snapshot and subscribe", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", maxPendingChars: 1000 });
  hub.append("terminal", "snapshot");
  const snapshot = hub.attach("terminal", "control-sse:one", { paused: true });
  hub.append("terminal", "after-snapshot");

  assert.deepEqual(hub.pollTerminal("terminal", 0), [], "paused consumer does not overtake its snapshot");
  assert.equal(hub.resumeConsumer("terminal", "control-sse:one"), true);
  const [delivery] = hub.pollTerminal("terminal", 0);
  assert.equal(delivery.consumerId, "control-sse:one");
  assert.equal(delivery.fromSequence, snapshot.throughSequence + 1);
  assert.equal(delivery.data, "after-snapshot");
});

test("a paused control consumer fault recovers with an explicit sequenced reset", () => {
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxPendingChars: 5,
    maxSnapshotChars: 1000,
  });
  const snapshot = hub.attach("terminal", "control-sse:fault", { paused: true });
  hub.append("terminal", "1234");
  hub.append("terminal", "5678");
  hub.resumeConsumer("terminal", "control-sse:fault");
  const [delivery] = hub.pollTerminal("terminal", 0);
  assert.equal(delivery.reset, true);
  assert.equal(delivery.fromSequence, 0);
  assert.equal(delivery.sequence, snapshot.throughSequence + 2);
  assert.equal(delivery.data, "12345678");
});

test("renderer replay is capped independently from the retained control buffer", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", maxSnapshotChars: 200_000 });
  const retained = "x".repeat(150_000);
  hub.append("terminal", retained);
  const renderer = hub.attach("terminal", "renderer", { replayMaxChars: 64 * 1024 });
  const control = hub.attach("terminal", "control", { replayMaxChars: 200_000 });

  assert.ok(renderer.buffer.length <= 64 * 1024);
  assert.equal(renderer.buffer.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  assert.equal(control.buffer, retained);
  assert.equal(hub.getBuffer("terminal"), retained, "view replay limits never shrink authoritative retention");
  const diagnostics = hub.diagnostics();
  assert.equal(diagnostics.replayCount, 2);
  assert.ok(diagnostics.replayBytes >= Buffer.byteLength(control.buffer));
  assert.ok(diagnostics.replayDurationMs >= 0);
  assert.ok(diagnostics.maxReplayDurationMs >= 0);
});

test("per-consumer replay limits persist across overflow reset snapshots", () => {
  const rendererLimit = 64 * 1024;
  const controlLimit = 96 * 1024;
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxSnapshotChars: 200_000,
    maxPendingChars: 32,
  });
  hub.attach("terminal", "renderer", { replayMaxChars: rendererLimit });
  hub.attach("terminal", "control-sse", { replayMaxChars: controlLimit });
  hub.append("terminal", "q".repeat(150_000));

  const deliveries = hub.pollTerminal("terminal", 0);
  const rendererReset = deliveries.find((delivery) => delivery.consumerId === "renderer");
  const controlReset = deliveries.find((delivery) => delivery.consumerId === "control-sse");
  assert.ok(rendererReset && controlReset);
  assert.equal(rendererReset.reset, true);
  assert.equal(controlReset.reset, true);
  assert.ok(rendererReset.data.length <= rendererLimit);
  assert.ok(controlReset.data.length <= controlLimit);
  assert.equal(rendererReset.data.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  assert.equal(controlReset.data.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  assert.equal(hub.getBuffer("terminal").length, 150_000);
});

test("repeated multi-pane navigation keeps each replay bounded and releases consumers", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", maxSnapshotChars: 200_000 });
  hub.append("terminal", "z".repeat(180_000));
  for (let index = 0; index < 32; index += 1) {
    const consumer = `renderer:${index}`;
    const snapshot = hub.attach("terminal", consumer, { replayMaxChars: 64 * 1024 });
    assert.ok(snapshot.buffer.length <= 64 * 1024);
    hub.detach("terminal", consumer);
  }
  assert.equal(hub.diagnostics().subscribers, 0);
  assert.equal(hub.getBuffer("terminal").length, 180_000);
});

test("empty PTY chunks do not consume sequence numbers or create false gaps", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch" });
  const snapshot = hub.attach("terminal", "renderer");
  assert.equal(hub.append("terminal", ""), snapshot.throughSequence);
  hub.append("terminal", "visible");
  const [delivery] = hub.poll(0);
  assert.equal(delivery.fromSequence, snapshot.throughSequence + 1);
  assert.equal(delivery.sequence, snapshot.throughSequence + 1);
});

test("a UTF-16 surrogate pair split across PTY chunks is delivered as one code point", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch" });
  const snapshot = hub.attach("terminal", "renderer");
  assert.equal(hub.append("terminal", "\ud83d"), snapshot.throughSequence);
  assert.equal(hub.append("terminal", ""), snapshot.throughSequence);
  hub.append("terminal", "\ude00!");
  const [delivery] = hub.poll(0);
  assert.equal(delivery.data, "😀!");
  assert.equal(delivery.fromSequence, snapshot.throughSequence + 1);
});

test("an unmatched carried high surrogate is replaced before later ordinary text", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch" });
  hub.attach("terminal", "renderer");
  hub.append("terminal", "\ud83d");
  hub.append("terminal", "plain");
  const [delivery] = hub.poll(0);
  assert.equal(delivery.data, "\ufffdplain");
});

test("a delayed drain ACK holds only that consumer and preserves later bytes", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 1000 });
  hub.attach("terminal", "slow");
  hub.append("terminal", "first");
  const [first] = hub.poll(0);
  hub.append("terminal", "second");
  assert.deepEqual(hub.poll(500), [], "second batch remains behind the drain ACK");
  assert.equal(hub.acknowledge("terminal", "slow", first.epoch, first.sequence), true);
  const [second] = hub.poll(500);
  assert.equal(second.data, "second");
  assert.equal(second.fromSequence, first.sequence + 1);
});

test("an exit cursor stays behind final output queued after an in-flight batch", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 1000 });
  hub.attach("terminal", "renderer");
  hub.append("terminal", "first");
  const [first] = hub.poll(0);
  hub.append("terminal", "final-before-exit");
  const exitCursor = hub.cursor("terminal");

  assert.equal(exitCursor.sequence, first.sequence + 1);
  assert.equal(hub.hasPendingDeliveriesForTerminal("terminal"), true);
  assert.deepEqual(hub.poll(100), [], "final output remains ordered behind the first drain ACK");
  assert.equal(hub.acknowledge("terminal", "renderer", first.epoch, first.sequence), true);
  const [final] = hub.poll(100);
  assert.equal(final.data, "final-before-exit");
  assert.equal(final.sequence, exitCursor.sequence, "the exit cursor names the final delivered batch");
  assert.equal(hub.acknowledge("terminal", "renderer", final.epoch, final.sequence), true);
  assert.equal(hub.hasPendingDeliveriesForTerminal("terminal"), false);
});

test("exit ordering survives pending overflow by delivering a reset through the exit cursor", () => {
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxPendingChars: 5,
    maxSnapshotChars: 1000,
  });
  hub.attach("terminal", "renderer");
  hub.append("terminal", "live");
  const [inFlight] = hub.poll(0);
  hub.append("terminal", "after");
  hub.append("terminal", "-overflow");
  const exitCursor = hub.cursor("terminal");

  assert.deepEqual(hub.poll(100), []);
  assert.equal(hub.acknowledge("terminal", "renderer", inFlight.epoch, inFlight.sequence), true);
  const [reset] = hub.poll(100);
  assert.equal(reset.reset, true);
  assert.equal(reset.sequence, exitCursor.sequence);
  assert.equal(reset.data, "liveafter-overflow");
});

test("lost ACK retry does not invent a new sequence or discard the payload", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 1000 });
  hub.attach("terminal", "renderer");
  hub.append("terminal", "payload");
  const [first] = hub.poll(0);
  assert.deepEqual(hub.poll(999), []);
  const [retry] = hub.poll(1000);
  assert.deepEqual(retry, first);
  assert.equal(hub.acknowledge("terminal", "renderer", retry.epoch, retry.sequence), true);
  assert.equal(hub.acknowledge("terminal", "renderer", retry.epoch, retry.sequence), false);
});

test("pending overflow becomes an explicit reset snapshot", () => {
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxPendingChars: 5,
    maxSnapshotChars: 1000,
  });
  hub.attach("terminal", "renderer");
  hub.append("terminal", "1234");
  hub.append("terminal", "5678");
  const [delivery] = hub.poll(0);
  assert.equal(delivery.reset, true);
  assert.equal(delivery.data, "12345678");
  assert.equal(delivery.sequence, 2);
  assert.equal(hub.diagnostics().resets, 1);
  assert.equal(hub.diagnostics().droppedOrTruncatedChars, 0, "reset snapshot recovered the pending bytes");
});

test("finalize replaces an unmatched high surrogate as sequenced output before exit", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch" });
  const snapshot = hub.attach("terminal", "renderer");
  assert.equal(hub.append("terminal", "\ud83d"), snapshot.throughSequence);
  assert.equal(hub.finalize("terminal"), snapshot.throughSequence + 1);
  const exitCursor = hub.cursor("terminal");
  const [delivery] = hub.poll(0);
  assert.equal(delivery.data, "\ufffd");
  assert.equal(delivery.sequence, exitCursor.sequence);
  assert.equal(hub.getBuffer("terminal"), "\ufffd");
  assert.equal(hub.finalize("terminal"), exitCursor.sequence, "finalization is idempotent");
});

test("clearing expired output state creates a new epoch for stale-exit detection", () => {
  let epoch = 0;
  const hub = new TerminalOutputStreamHub({ epochFactory: () => `epoch-${++epoch}` });
  hub.append("terminal", "final");
  const exited = hub.cursor("terminal");
  hub.clearTerminal("terminal");
  const replacement = hub.attach("terminal", "renderer");
  assert.notEqual(replacement.epoch, exited.epoch);
  assert.equal(replacement.throughSequence, 0);
  assert.equal(replacement.buffer, "");
});

test("late stale-exit attach churn releases empty phantom terminal epochs", () => {
  let epoch = 0;
  const hub = new TerminalOutputStreamHub({ epochFactory: () => `epoch-${++epoch}` });
  for (let index = 0; index < 100; index += 1) {
    hub.attach("expired", `renderer:${index}`);
    assert.deepEqual(hub.terminalIds(), ["expired"]);
    hub.detach("expired", `renderer:${index}`);
    assert.deepEqual(hub.terminalIds(), []);
  }
  assert.equal(hub.diagnostics().subscribers, 0);
});

test("rolling snapshot truncation is explicit and counted separately from reset recovery", () => {
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxSnapshotChars: TERMINAL_OUTPUT_TRUNCATED_NOTICE.length + 8,
  });
  hub.append("terminal", "x".repeat(200));
  const snapshot = hub.attach("terminal", "renderer");
  assert.equal(snapshot.buffer.startsWith(TERMINAL_OUTPUT_TRUNCATED_NOTICE), true);
  assert.ok(hub.diagnostics().droppedOrTruncatedChars > 0);
  assert.equal(hub.diagnostics().resets, 0);
});

test("slow consumers and terminals do not block each other", () => {
  let epoch = 0;
  const hub = new TerminalOutputStreamHub({ epochFactory: () => `epoch-${++epoch}`, ackTimeoutMs: 1000 });
  hub.attach("one", "renderer");
  hub.attach("two", "renderer");
  hub.append("one", "one-a");
  hub.append("two", "two-a");
  const initial = hub.poll(0);
  const one = initial.find((item) => item.id === "one");
  const two = initial.find((item) => item.id === "two");
  assert.ok(one && two);
  assert.equal(hub.acknowledge("two", "renderer", two.epoch, two.sequence), true);
  hub.append("one", "one-b");
  hub.append("two", "two-b");
  const [next] = hub.poll(100);
  assert.equal(next.id, "two");
  assert.equal(next.data, "two-b");
});

test("capped renderer batches stay contiguous and lose nothing while catching up", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 1000 });
  const snapshot = hub.attach("terminal", "renderer", { maxBatchChars: 10 });
  const chunks = ["aaaa", "bbbb", "cccc", "dddddddddddddddd", "ee"];
  for (const chunk of chunks) hub.append("terminal", chunk);

  const received = [];
  let expectedFrom = snapshot.throughSequence + 1;
  for (let now = 0; now < 100; now += 1) {
    const [delivery] = hub.poll(now);
    if (!delivery) break;
    assert.equal(delivery.reset, false);
    assert.equal(delivery.fromSequence, expectedFrom, "no sequence gap between capped batches");
    assert.ok(delivery.data.length <= 10 || delivery.fromSequence === delivery.sequence);
    received.push(delivery.data);
    expectedFrom = delivery.sequence + 1;
    assert.equal(hub.acknowledge("terminal", "renderer", delivery.epoch, delivery.sequence), true);
  }
  assert.deepEqual(received, ["aaaabbbb", "cccc", "dddddddddddddddd", "ee"]);
});

test("a backlog just over 64K no longer forces a reset snapshot", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 1000 });
  hub.attach("terminal", "renderer", { replayMaxChars: 64 * 1024, maxBatchChars: 64 * 1024 });
  hub.append("terminal", "first");
  const [inFlight] = hub.poll(0);
  const burst = ["x".repeat(40_000), "y".repeat(24_001), "z".repeat(10_000)];
  for (const chunk of burst) hub.append("terminal", chunk);
  assert.ok(DEFAULT_CONSUMER_RESET_BACKLOG_CHARS > 64_001);
  hub.acknowledge("terminal", "renderer", inFlight.epoch, inFlight.sequence);
  const [next] = hub.poll(10);
  assert.equal(next.reset, false);
  assert.equal(next.data, burst.slice(0, 2).join(""));
  assert.equal(hub.diagnostics().resets, 0);
});

test("overflow resets are rate limited per consumer", () => {
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxPendingChars: 5,
    maxSnapshotChars: 1000,
    minResetIntervalMs: 2000,
  });
  hub.attach("terminal", "renderer");
  hub.append("terminal", "123456");
  const [firstReset] = hub.poll(1000);
  assert.equal(firstReset.reset, true);
  hub.acknowledge("terminal", "renderer", firstReset.epoch, firstReset.sequence);

  hub.append("terminal", "abcdef");
  assert.deepEqual(hub.poll(1500), [], "a second reset inside the interval is deferred");
  assert.equal(hub.hasSendableConsumer("terminal", 1500), false, "no busy flush while deferred");
  assert.equal(hub.nextFlushDelayMs(1500, 16), 1500, "flush is rescheduled for the reset deadline");
  hub.append("terminal", "later");
  const [secondReset] = hub.poll(3000);
  assert.equal(secondReset.reset, true);
  assert.equal(secondReset.data, "123456abcdeflater", "the deferred reset replays everything current");
  assert.equal(hub.diagnostics().resets, 2);
});

test("backlog accounting counts pending plus in-flight output of live consumers only", () => {
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", maxPendingChars: 100 });
  hub.attach("terminal", "renderer");
  hub.attach("terminal", "control", { paused: true });
  hub.append("terminal", "a".repeat(30));
  hub.poll(0);
  hub.append("terminal", "b".repeat(20));
  assert.equal(hub.backlogChars("terminal"), 50, "30 in flight + 20 pending; paused consumer ignored");
  assert.equal(hub.consumerCount("terminal"), 2);
  hub.append("terminal", "c".repeat(90));
  assert.equal(hub.backlogChars("terminal"), 0, "a consumer awaiting a reset no longer holds back the PTY");
});

function fakeTimers() {
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
    pending: () => timers.size,
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

function flowController(overrides = {}) {
  const timers = fakeTimers();
  const signals = [];
  const flow = new TerminalFlowController({
    // Pausing is POSIX-only; pin the platform so these run on any host OS.
    platform: "linux",
    highWaterChars: 100,
    lowWaterChars: 20,
    maxPauseMs: 2000,
    bypassMs: 30_000,
    setPaused: (id, paused) => signals.push([id, paused]),
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { flow, signals, timers };
}

test("backpressure pauses above the high-water mark and resumes at the low-water mark", () => {
  const { flow, signals, timers } = flowController();
  flow.update("t", 100);
  assert.deepEqual(signals, [], "at the high-water mark is not yet over it");
  flow.update("t", 101);
  assert.deepEqual(signals, [["t", true]]);
  flow.update("t", 500);
  flow.update("t", 21);
  assert.deepEqual(signals, [["t", true]], "idempotent while paused; hysteresis above low water");
  assert.equal(flow.isPaused("t"), true);
  flow.update("t", 20);
  assert.deepEqual(signals, [["t", true], ["t", false]]);
  assert.equal(flow.isPaused("t"), false);
  assert.equal(timers.pending(), 0, "resume cancels the max-pause timer");
  flow.update("t", 101);
  assert.deepEqual(signals.at(-1), ["t", true], "pauses again on the next overflow");
  assert.equal(flow.diagnostics().pauses, 2);
});

test("a stalled consumer cannot pause the PTY past the cap; backpressure is bypassed for a while", () => {
  const { flow, signals, timers } = flowController();
  flow.update("t", 1_000);
  timers.advance(1999);
  assert.equal(flow.isPaused("t"), true);
  timers.advance(1);
  assert.deepEqual(signals, [["t", true], ["t", false]], "forced resume at the max pause");
  assert.equal(flow.diagnostics().forcedResumes, 1);

  flow.update("t", 5_000);
  timers.advance(29_000);
  flow.update("t", 5_000);
  assert.equal(signals.length, 2, "no re-pause during the bypass window");
  timers.advance(1_000);
  flow.update("t", 5_000);
  assert.deepEqual(signals.at(-1), ["t", true], "backpressure applies again after the bypass");
});

test("forgetting a terminal resumes a paused PTY and drops its state", () => {
  const { flow, signals, timers } = flowController();
  flow.update("t", 1_000);
  flow.update("other", 1_000);
  assert.deepEqual(flow.pausedTerminalIds().sort(), ["other", "t"]);
  flow.forget("t");
  assert.deepEqual(signals.at(-1), ["t", false]);
  assert.deepEqual(flow.pausedTerminalIds(), ["other"]);
  flow.forget("t");
  assert.equal(signals.filter(([id]) => id === "t").length, 2, "forget is idempotent");
  assert.equal(timers.pending(), 1);
});

test("hub + flow controller: a slow renderer pauses the PTY and its ACKs resume it", () => {
  const { flow, signals } = flowController({ highWaterChars: 256, lowWaterChars: 64 });
  const hub = new TerminalOutputStreamHub({ epochFactory: () => "epoch", ackTimeoutMs: 10_000 });
  hub.attach("terminal", "renderer", { maxBatchChars: 64 });
  const update = () => flow.update("terminal", hub.backlogChars("terminal"));
  let delivered = "";
  let produced = "";
  let inFlight = null;
  const deliver = (now) => {
    const [delivery] = hub.pollTerminal("terminal", now);
    if (!delivery) return;
    inFlight = delivery;
    delivered += delivery.data;
  };

  deliver(0);
  for (let index = 0; index < 20; index += 1) {
    const chunk = String(index % 10).repeat(32);
    produced += chunk;
    hub.append("terminal", chunk);
    update();
    if (!inFlight) deliver(0);
  }
  assert.deepEqual(signals, [["terminal", true]], "producer paused once the renderer fell behind");
  assert.equal(flow.isPaused("terminal"), true);

  // The renderer drains one capped batch at a time; each ACK shrinks the backlog.
  for (let now = 1; flow.isPaused("terminal") && now < 100; now += 1) {
    assert.equal(hub.acknowledge("terminal", "renderer", inFlight.epoch, inFlight.sequence), true);
    inFlight = null;
    deliver(now);
    update();
  }
  assert.deepEqual(signals, [["terminal", true], ["terminal", false]]);
  assert.ok(hub.backlogChars("terminal") <= 64);
  assert.equal(produced.startsWith(delivered), true, "every delivered byte is in order");
  assert.equal(hub.diagnostics().resets, 0);
});

test("PTY host flow gate pauses once, resumes on request, and auto-resumes as a failsafe", () => {
  const timers = fakeTimers();
  const calls = [];
  const live = new Set(["t"]);
  const gate = new PtyFlowGate({
    pause: (id) => {
      if (!live.has(id)) return false;
      calls.push(["pause", id]);
      return true;
    },
    resume: (id) => calls.push(["resume", id]),
  }, { platform: "linux", maxPauseMs: 15_000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  gate.apply("missing", true);
  assert.equal(gate.isPaused("missing"), false, "unknown PTYs are never marked paused");
  gate.apply("t", true);
  gate.apply("t", true);
  assert.deepEqual(calls, [["pause", "t"]]);
  gate.apply("t", false);
  gate.apply("t", false);
  assert.deepEqual(calls, [["pause", "t"], ["resume", "t"]]);
  assert.equal(timers.pending(), 0);

  gate.apply("t", true);
  timers.advance(15_000);
  assert.deepEqual(calls.at(-1), ["resume", "t"], "failsafe resume");
  assert.equal(gate.isPaused("t"), false);

  gate.apply("t", true);
  gate.release("t");
  assert.deepEqual(calls.at(-1), ["resume", "t"], "released before kill");
  gate.apply("t", true);
  gate.forget("t");
  assert.equal(calls.at(-1)[0], "pause", "forget never touches an exited PTY");
  assert.equal(timers.pending(), 0);
});

test("PTY host client sends fire-and-forget flow messages without spawning a host", () => {
  const client = new PtyHostClient();
  client.setFlowPaused("t", true);
  assert.equal(client.child, null, "no host is forked just for flow control");

  const sent = [];
  client.child = {
    killed: false,
    connected: true,
    send: (message, callback) => {
      sent.push(message);
      assert.equal(typeof callback, "function", "send failures must not surface as child errors");
      return true;
    },
  };
  client.setFlowPaused("t", true);
  client.setFlowPaused("t", false);
  assert.deepEqual(sent, [
    { type: "flow", id: "t", paused: true },
    { type: "flow", id: "t", paused: false },
  ]);
  client.child = { killed: false, connected: true, send: () => { throw new Error("channel closed"); } };
  assert.doesNotThrow(() => client.setFlowPaused("t", true));
  client.child = null;
});

test("end-to-end: PTY bursts just over 64K reach the renderer intact with no reset", () => {
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    ackTimeoutMs: 10_000,
    maxSnapshotChars: 1_000_000,
  });
  const snapshot = hub.attach("terminal", "renderer", { replayMaxChars: 64 * 1024, maxBatchChars: 64 * 1024 });
  const batcher = new TerminalOutputBatcher(
    (id, data) => hub.append(id, data),
    DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS,
  );
  const esc = String.fromCharCode(0x1b);
  let produced = "";
  for (let window = 0; window < 6; window += 1) {
    // One 16ms PTY window whose output totals the batch cap + 1, split the way
    // node-pty hands over reads, including a surrogate pair and SGR sequences.
    const head = `${esc}[3${window}m${"a".repeat(40_000)}`;
    const tailPrefix = "😀";
    const tailSuffix = `${esc}[0m`;
    const fill = DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS + 1 - head.length - tailPrefix.length - tailSuffix.length;
    const parts = [head, `${tailPrefix}${"b".repeat(fill)}${tailSuffix}`];
    assert.equal(parts.join("").length, DEFAULT_PENDING_TERMINAL_OUTPUT_MAX_CHARS + 1);
    for (const part of parts) {
      produced += part;
      batcher.push("terminal", part);
    }
    batcher.flushAll();
  }
  let rendered = "";
  let expectedFrom = snapshot.throughSequence + 1;
  for (let now = 0; now < 100; now += 1) {
    const [delivery] = hub.poll(now);
    if (!delivery) break;
    assert.equal(delivery.reset, false);
    assert.equal(delivery.fromSequence, expectedFrom);
    expectedFrom = delivery.sequence + 1;
    rendered += delivery.data;
    hub.acknowledge("terminal", "renderer", delivery.epoch, delivery.sequence);
  }
  assert.equal(rendered.length, produced.length);
  assert.equal(rendered, produced);
  assert.equal(rendered.includes(TERMINAL_OUTPUT_TRUNCATED_NOTICE), false);
  assert.equal(hub.diagnostics().resets, 0);
  assert.equal(hub.diagnostics().droppedOrTruncatedChars, 0);
});

test("PTY pausing is disabled on Windows in both main and the host", () => {
  assert.equal(ptyFlowControlSupported("win32"), false);
  assert.equal(ptyFlowControlSupported("linux"), true);
  assert.equal(ptyFlowControlSupported("darwin"), true);

  const { flow, signals, timers } = flowController({ platform: "win32" });
  flow.update("t", 10_000_000);
  timers.advance(60_000);
  flow.update("t", 10_000_000);
  assert.deepEqual(signals, [], "main never requests a pause on win32");
  assert.equal(flow.isPaused("t"), false);
  assert.equal(timers.pending(), 0);

  const calls = [];
  const gate = new PtyFlowGate({
    pause: (id) => {
      calls.push(["pause", id]);
      return true;
    },
    resume: (id) => calls.push(["resume", id]),
  }, { platform: "win32" });
  gate.apply("t", true);
  assert.deepEqual(calls, [], "the host ignores pause requests on win32 as a second guard");
  assert.equal(gate.isPaused("t"), false);
});

test("Windows falls back to rate-limited resets for a slow consumer instead of pausing", () => {
  const { flow, signals } = flowController({ platform: "win32", highWaterChars: 10, lowWaterChars: 2 });
  const hub = new TerminalOutputStreamHub({
    epochFactory: () => "epoch",
    maxPendingChars: 50,
    maxSnapshotChars: 1_000,
    minResetIntervalMs: 2_000,
  });
  hub.attach("terminal", "renderer", { maxBatchChars: 20 });
  hub.append("terminal", "first");
  const [inFlight] = hub.poll(0);
  for (let index = 0; index < 10; index += 1) {
    hub.append("terminal", "x".repeat(10));
    flow.update("terminal", hub.backlogChars("terminal"));
  }
  assert.deepEqual(signals, []);
  hub.acknowledge("terminal", "renderer", inFlight.epoch, inFlight.sequence);
  const [reset] = hub.poll(10);
  assert.equal(reset.reset, true, "overflow recovers with an explicit snapshot");
  assert.equal(reset.data, `first${"x".repeat(100)}`);
});

test("a paused PTY whose process exits is resumed so node-pty cannot drop its unread tail", () => {
  const timers = fakeTimers();
  const calls = [];
  let alive = true;
  const gate = new PtyFlowGate({
    pause: (id) => {
      calls.push(["pause", id]);
      return true;
    },
    resume: (id) => calls.push(["resume", id]),
    isAlive: () => alive,
  }, { platform: "linux", livenessPollMs: 50, setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  gate.apply("t", true);
  timers.advance(500);
  assert.equal(gate.isPaused("t"), true, "a live paused process stays paused");
  alive = false;
  timers.advance(50);
  assert.deepEqual(calls, [["pause", "t"], ["resume", "t"]], "resumed within one poll of the exit");
  assert.equal(gate.isPaused("t"), false);
  assert.equal(timers.pending(), 0, "liveness polling and the failsafe stop after release");

  alive = true;
  gate.apply("t", true);
  gate.release("t");
  assert.equal(timers.pending(), 0, "no liveness polling while not paused");
  assert.deepEqual(gate.pausedIds(), []);
});

test("kill waits for a released PTY's output to go quiet, capped", () => {
  const timers = fakeTimers();
  let lastOutputAt = 0;
  let doneAt = null;
  const options = { quietMs: 50, maxMs: 300, now: timers.now, setTimer: timers.setTimer };

  afterOutputQuiet(() => lastOutputAt, () => { doneAt = timers.now(); }, options);
  timers.advance(49);
  assert.equal(doneAt, null);
  timers.advance(1);
  assert.equal(doneAt, 50, "no output: kill after the quiet window");

  doneAt = null;
  const startedAt = timers.now();
  afterOutputQuiet(() => lastOutputAt, () => { doneAt = timers.now(); }, options);
  for (let step = 0; step < 4; step += 1) {
    timers.advance(30);
    lastOutputAt = timers.now();
  }
  timers.advance(49);
  assert.equal(doneAt, null, "still draining while output keeps arriving");
  timers.advance(1);
  assert.equal(doneAt, startedAt + 170, "quiet 50ms after the last output");

  doneAt = null;
  const cappedStart = timers.now();
  afterOutputQuiet(() => lastOutputAt, () => { doneAt = timers.now(); }, options);
  for (let step = 0; step < 20 && doneAt == null; step += 1) {
    timers.advance(20);
    lastOutputAt = timers.now();
  }
  assert.equal(doneAt, cappedStart + 300, "a PTY that never goes quiet is killed at the cap");
});
