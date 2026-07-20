import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OUTPUT_ACK_TIMEOUT_MS,
  OutputAckGate,
} from "../dist-electron/terminal-output-ack.js";
import { TerminalOutputStreamHub } from "../dist-electron/terminal-output-stream.js";
import { TERMINAL_OUTPUT_TRUNCATED_NOTICE } from "../dist-electron/terminal-buffer.js";
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
