import assert from "node:assert/strict";
import test from "node:test";

import {
  jarvisActivityView,
  jarvisConnectionSummary,
  jarvisDockMeta,
  jarvisDockPreview,
  jarvisErrorMessage,
  jarvisFeedLabel,
  jarvisFeedRole,
  jarvisLicenseSummary,
  jarvisLicenseView,
  jarvisModelLabel,
  jarvisRelativeTime,
  jarvisStatusView,
} from "../src/jarvis-view.ts";

const now = Date.parse("2026-10-27T12:00:00Z");
const day = 24 * 60 * 60_000;

function license(overrides = {}) {
  return {
    licensed: true,
    detail: null,
    offlineUntil: now + 20 * day,
    licenseId: "lic-1",
    keyMasked: "JARV-••••-••••-7Q2K",
    instanceName: "omarchy",
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    license: license(),
    installPath: "C:\\Users\\alan\\AppData\\Local\\Jarvis AI\\jarvis-hud.exe",
    running: true,
    connected: true,
    micOpen: true,
    activity: "idle",
    partial: null,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    agents: [],
    feed: [],
    lastError: null,
    updatedAt: now,
    ...overrides,
  };
}

const unlicensed = license({ licensed: false, detail: "Jarvis is not activated on this computer", offlineUntil: null, licenseId: null });

test("jarvisLicenseView is calm without a license and nudges before it lapses offline", () => {
  assert.deepEqual(jarvisLicenseView(null, now), { tone: "muted", label: "Checking" });
  assert.deepEqual(jarvisLicenseView(unlicensed, now), { tone: "muted", label: "Not licensed" });
  assert.deepEqual(jarvisLicenseView(license(), now), { tone: "ok", label: "Licensed" });
  assert.deepEqual(jarvisLicenseView(license({ offlineUntil: now + day }), now), { tone: "warn", label: "Renew soon" });
  assert.deepEqual(jarvisLicenseView(license({ offlineUntil: null }), now), { tone: "ok", label: "Licensed" });
});

test("jarvisLicenseSummary explains the offline window or the reason it does not count", () => {
  const summary = jarvisLicenseSummary(license(), now);
  assert.match(summary, /^Verified on this computer \(omarchy\)\. Works offline until .*2026; Jarvis renews it whenever it is online\.$/);
  assert.match(jarvisLicenseSummary(license({ offlineUntil: now + day, instanceName: null }), now), /^Verified on this computer until .*2026\. Open Jarvis while online to renew it\.$/);
  assert.equal(jarvisLicenseSummary(license({ offlineUntil: null, instanceName: null }), now), "Verified on this computer.");
  assert.equal(jarvisLicenseSummary(unlicensed, now), "Jarvis is not activated on this computer.");
  assert.equal(jarvisLicenseSummary(license({ licensed: false, detail: "Jarvis needs the desktop app." }), now), "Jarvis needs the desktop app.");
  assert.equal(jarvisLicenseSummary(license({ licensed: false, detail: null }), now), "Jarvis is not activated on this computer.");
});

test("jarvisStatusView only warns license holders", () => {
  assert.deepEqual(jarvisStatusView(null), { tone: "muted", label: "Checking" });
  assert.deepEqual(jarvisStatusView(state()), { tone: "ok", label: "Connected" });
  assert.deepEqual(jarvisStatusView(state({ connected: false })), { tone: "warn", label: "Connecting" });
  assert.deepEqual(jarvisStatusView(state({ connected: false, running: false })), { tone: "muted", label: "Not running" });
  assert.deepEqual(jarvisStatusView(state({ connected: false, running: false, installPath: null })), { tone: "warn", label: "Not installed" });
  const noLicense = { license: unlicensed, connected: false };
  assert.deepEqual(jarvisStatusView(state(noLicense)), { tone: "muted", label: "Not linked" });
  assert.deepEqual(jarvisStatusView(state({ ...noLicense, running: false, installPath: null })), { tone: "muted", label: "Not installed" });
});

test("jarvisConnectionSummary names the model once linked", () => {
  assert.equal(jarvisConnectionSummary(null), "Looking for Jarvis on this computer…");
  assert.equal(jarvisConnectionSummary(state()), "Linked to Jarvis, which is using anthropic · claude-sonnet-4-5.");
  assert.equal(jarvisConnectionSummary(state({ provider: null, model: null })), "Linked to Jarvis.");
  assert.equal(jarvisConnectionSummary(state({ connected: false })), "Jarvis is running. Linking to it…");
  assert.match(jarvisConnectionSummary(state({ connected: false, license: unlicensed })), /only when this computer holds a Jarvis license/);
  assert.equal(jarvisConnectionSummary(state({ connected: false, running: false })), "Jarvis is not running. Athena links to it as soon as it starts.");
});

test("jarvisModelLabel and jarvisDockMeta skip what Jarvis has not reported", () => {
  assert.equal(jarvisModelLabel(state()), "anthropic · claude-sonnet-4-5");
  assert.equal(jarvisModelLabel(state({ provider: null })), "claude-sonnet-4-5");
  assert.equal(jarvisModelLabel(state({ provider: " ", model: null })), null);
  assert.equal(jarvisModelLabel(null), null);
  const agent = (working) => ({ name: "codex", cwd: null, task: null, working, focused: false, status: null });
  assert.equal(jarvisDockMeta(state({ agents: [agent(true), agent(false)] })), "anthropic · claude-sonnet-4-5 · 1 agent working");
  assert.equal(jarvisDockMeta(state({ provider: null, model: null, agents: [agent(true), agent(true)] })), "2 agents working");
  assert.equal(jarvisDockMeta(state({ provider: null, model: null })), null);
});

test("jarvisActivityView maps the bus activity to the orb, offline until attached", () => {
  assert.deepEqual(jarvisActivityView(null), { tone: "offline", label: "Not running" });
  assert.deepEqual(jarvisActivityView(state({ running: false, connected: false })), { tone: "offline", label: "Not running" });
  assert.deepEqual(jarvisActivityView(state({ connected: false, activity: "speaking" })), { tone: "offline", label: "Connecting…" });
  assert.deepEqual(jarvisActivityView(state()), { tone: "idle", label: "Ready" });
  assert.deepEqual(jarvisActivityView(state({ micOpen: false })), { tone: "idle", label: "Mic off" });
  assert.deepEqual(jarvisActivityView(state({ activity: "listening" })), { tone: "listening", label: "Listening" });
  assert.deepEqual(jarvisActivityView(state({ activity: "thinking" })), { tone: "thinking", label: "Thinking" });
  assert.deepEqual(jarvisActivityView(state({ activity: "speaking" })), { tone: "speaking", label: "Speaking" });
});

test("feed items are labeled by who they came from", () => {
  const item = (kind, extra = {}) => ({ id: 1, at: now, kind, text: "hello", ...extra });
  assert.deepEqual(
    ["heard", "asked", "said", "announce", "agent"].map((kind) => jarvisFeedRole(item(kind))),
    ["user", "user", "jarvis", "system", "system"],
  );
  assert.equal(jarvisFeedLabel(item("heard")), "You");
  assert.equal(jarvisFeedLabel(item("asked", { agent: "athena" })), "You, typed");
  assert.equal(jarvisFeedLabel(item("asked", { agent: "remote" })), "You, typed remotely");
  assert.equal(jarvisFeedLabel(item("said")), "Jarvis");
  assert.equal(jarvisFeedLabel(item("announce")), "Announcement");
  assert.equal(jarvisFeedLabel(item("agent", { agent: "codex on omarchy" })), "codex on omarchy");
  assert.equal(jarvisFeedLabel(item("agent")), "Agent");
});

test("jarvisDockPreview prefers the live transcript over the latest feed item", () => {
  const feed = [{ id: 1, at: now, kind: "said", text: "The build passed on omarchy." }];
  assert.deepEqual(jarvisDockPreview(state({ feed, partial: "start codex on" })), { text: "start codex on", live: true });
  assert.deepEqual(jarvisDockPreview(state({ feed })), { text: "Jarvis: The build passed on omarchy.", live: false });
  assert.equal(jarvisDockPreview(state()), null);
  assert.equal(jarvisDockPreview(null), null);
});

test("jarvisRelativeTime reads like Remote access activity", () => {
  assert.equal(jarvisRelativeTime(now - 4_000, now), "just now");
  assert.equal(jarvisRelativeTime(now + 5_000, now), "just now");
  assert.equal(jarvisRelativeTime(now - 40_000, now), "40s ago");
  assert.equal(jarvisRelativeTime(now - 3 * 60_000, now), "3m ago");
  assert.equal(jarvisRelativeTime(now - 2 * 60 * 60_000, now), "2h ago");
  assert.equal(jarvisRelativeTime(now - 3 * day, now), "3d ago");
  assert.equal(jarvisRelativeTime(Number.NaN, now), "");
});

test("jarvisErrorMessage strips Electron's invoke wrapper and reads as a sentence", () => {
  assert.equal(
    jarvisErrorMessage(new Error("Error invoking remote method 'jarvis:ask': Error: Jarvis is not running")),
    "Jarvis is not running.",
  );
  assert.equal(jarvisErrorMessage(new Error("Jarvis needs the desktop app.")), "Jarvis needs the desktop app.");
  assert.equal(jarvisErrorMessage("keep requests under 4000 characters"), "Keep requests under 4000 characters.");
  assert.equal(jarvisErrorMessage(new Error("Error invoking remote method 'jarvis:setMic': ")), "Jarvis did not answer.");
});
