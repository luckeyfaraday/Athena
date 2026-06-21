import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_OUTPUT_ACK_TIMEOUT_MS, OutputAckGate } from "../dist-electron/terminal-output-ack.js";

test("allows a send when nothing is in flight", () => {
  const gate = new OutputAckGate(1000);
  assert.equal(gate.canSend("t", 0), true);
});

test("holds further sends until the batch is acknowledged", () => {
  const gate = new OutputAckGate(1000);
  const sequence = gate.markSent("t", 0);
  assert.equal(gate.canSend("t", 500), false);
  assert.equal(gate.acknowledge("t", sequence), true);
  assert.equal(gate.canSend("t", 500), true);
});

test("ignores acks that do not match the outstanding batch", () => {
  const gate = new OutputAckGate(1000);
  gate.markSent("t", 0);
  assert.equal(gate.acknowledge("t", 999), false);
  assert.equal(gate.canSend("t", 500), false, "stays gated on a stale ack");
});

test("treats an unacknowledged batch as lost after the timeout so output recovers", () => {
  // The wedge guard: a renderer that reloaded mid-batch never acks, so the gate
  // must release on its own once the ack window elapses instead of freezing the
  // terminal's live output forever.
  const gate = new OutputAckGate(2000);
  gate.markSent("t", 0);
  assert.equal(gate.canSend("t", 1999), false, "still waiting within the timeout");
  assert.equal(gate.canSend("t", 2000), true, "allows another send once the ack window elapses");
});

test("reports the remaining retry delay for a blocked batch", () => {
  const gate = new OutputAckGate(2000);
  gate.markSent("t", 1000);
  assert.equal(gate.retryDelayMs("t", 1500), 1500);
  assert.equal(gate.retryDelayMs("t", 2999), 1);
  assert.equal(gate.retryDelayMs("t", 3000), 0);
});

test("reports no retry delay after the batch is cleared", () => {
  const gate = new OutputAckGate(2000);
  const sequence = gate.markSent("t", 0);
  assert.equal(gate.acknowledge("t", sequence), true);
  assert.equal(gate.retryDelayMs("t", 100), null);
});

test("a late ack for a re-sent batch does not clear the fresh batch", () => {
  const gate = new OutputAckGate(2000);
  const first = gate.markSent("t", 0);
  assert.equal(gate.canSend("t", 2000), true);
  const second = gate.markSent("t", 2000);
  assert.notEqual(first, second);
  assert.equal(gate.acknowledge("t", first), false, "the stale ack is ignored");
  assert.equal(gate.canSend("t", 2100), false, "the resent batch is still in flight");
  assert.equal(gate.acknowledge("t", second), true);
});

test("clear() drops the in-flight batch", () => {
  const gate = new OutputAckGate(1000);
  gate.markSent("t", 0);
  gate.clear("t");
  assert.equal(gate.canSend("t", 0), true);
});

test("exposes a positive default ack timeout", () => {
  assert.equal(typeof DEFAULT_OUTPUT_ACK_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_OUTPUT_ACK_TIMEOUT_MS > 0);
});
