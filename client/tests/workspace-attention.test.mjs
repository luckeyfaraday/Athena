import assert from "node:assert/strict";
import test from "node:test";

import {
  attentionDelivery,
  attentionHeadline,
  defaultNotificationPreferences,
  mergeWorkspaceAttention,
  parseNotificationPreferences,
  serializeNotificationPreferences,
} from "../src/workspace-attention.ts";

test("merge preserves action priority and caps count", () => {
  assert.deepEqual(mergeWorkspaceAttention(undefined, "update"), { kind: "update", count: 1 });
  assert.deepEqual(mergeWorkspaceAttention({ kind: "update", count: 8 }, "action"), { kind: "action", count: 9 });
  assert.deepEqual(mergeWorkspaceAttention({ kind: "action", count: 9 }, "update"), { kind: "action", count: 9 });
});

test("notification preferences round-trip and fall back to defaults field by field", () => {
  const custom = { level: "action", sound: "soft", volume: 0.25, desktop: false };
  assert.deepEqual(parseNotificationPreferences(serializeNotificationPreferences(custom)), custom);
  assert.equal(parseNotificationPreferences(null), null);
  assert.equal(parseNotificationPreferences("not json"), null);
  assert.equal(parseNotificationPreferences("[]"), null);
  assert.deepEqual(parseNotificationPreferences('{"sound":"digital"}'), { ...defaultNotificationPreferences, sound: "digital" });
  assert.deepEqual(
    parseNotificationPreferences('{"level":"loud","sound":"airhorn","volume":7,"desktop":"yes"}'),
    { ...defaultNotificationPreferences, volume: 1 },
  );
});

const everything = defaultNotificationPreferences;
const other = { sessionWorkspaceKey: "c:/work/api", activeWorkspaceKey: "c:/work/web", windowFocused: true, commandRoomVisible: true };
const here = { ...other, sessionWorkspaceKey: "c:/work/web" };

test("terminals the user is looking at stay quiet", () => {
  assert.deepEqual(attentionDelivery("action", here, everything), { badge: false, sound: false, desktop: false, flash: false });
});

test("another workspace gets a tab badge and a sound, but no desktop notification while Athena is focused", () => {
  assert.deepEqual(attentionDelivery("update", other, everything), { badge: true, sound: true, desktop: false, flash: false });
});

test("with Athena in the background even the current workspace alerts, and prompts flash the taskbar", () => {
  const away = { ...here, windowFocused: false };
  assert.deepEqual(attentionDelivery("action", away, everything), { badge: false, sound: true, desktop: true, flash: true });
  assert.deepEqual(attentionDelivery("update", away, everything), { badge: false, sound: true, desktop: true, flash: false });
});

test("in another room of the focused window, the current workspace plays a sound only", () => {
  assert.deepEqual(
    attentionDelivery("action", { ...here, commandRoomVisible: false }, everything),
    { badge: false, sound: true, desktop: false, flash: false },
  );
});

test("preferences narrow what alerts, while tab badges always show", () => {
  const actionOnly = { ...everything, level: "action" };
  assert.deepEqual(attentionDelivery("update", other, actionOnly), { badge: true, sound: false, desktop: false, flash: false });
  assert.equal(attentionDelivery("action", other, actionOnly).sound, true);

  const off = { ...everything, level: "off" };
  assert.deepEqual(attentionDelivery("action", other, off), { badge: true, sound: false, desktop: false, flash: false });
  assert.deepEqual(attentionDelivery("action", { ...here, windowFocused: false }, off), { badge: false, sound: false, desktop: false, flash: false });

  assert.equal(attentionDelivery("action", other, { ...everything, sound: "none" }).sound, false);
  assert.equal(attentionDelivery("action", other, { ...everything, volume: 0 }).sound, false);
  assert.equal(attentionDelivery("action", { ...other, windowFocused: false }, { ...everything, desktop: false }).desktop, false);
});

test("events from terminals that are already gone are dropped", () => {
  assert.deepEqual(
    attentionDelivery("action", { ...other, sessionWorkspaceKey: null }, everything),
    { badge: false, sound: false, desktop: false, flash: false },
  );
});

test("headlines say what the terminal needs", () => {
  assert.equal(attentionHeadline("Claude 2", { kind: "action", reason: "approval", message: null }), "Claude 2 is waiting for your approval");
  assert.equal(attentionHeadline("Codex", { kind: "action", reason: "question", message: null }), "Codex has a question for you");
  assert.equal(attentionHeadline("Codex", { kind: "update", reason: "turn-complete", message: null }), "Codex finished");
  assert.equal(attentionHeadline("Shell", { kind: "update", reason: "exit", message: "Exited with code 1" }), "Shell exited (code 1)");
  assert.equal(attentionHeadline("Shell", { kind: "update", reason: "exit", message: null }), "Shell exited");
  assert.equal(attentionHeadline("Claude", { kind: "action", reason: "notification", message: "Claude needs your permission" }), "Claude needs you");
});
