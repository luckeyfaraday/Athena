import assert from "node:assert/strict";
import test from "node:test";

import {
  compactAccountLabel,
  compactAriaLabel,
  formatDuration,
  formatPercent,
  formatResetCountdown,
  headlineWindow,
  isLive,
  openWindows,
  statusLabel,
  usageLevel,
  usagePollDelay,
} from "../src/usage-display.ts";

const MODULE = "../src/usage-display.ts";
const NOW = Date.parse("2026-09-29T12:00:00Z");

function account(overrides = {}) {
  return {
    key: "claude:aaaa",
    provider: "claude",
    provider_name: "Claude",
    account: { email: "ada@example.com", display_name: "Ada", organization: null, identified: true },
    profiles: [{ label: "default", path: "~/.claude" }],
    plan: "Max 5x",
    status: "ok",
    message: null,
    windows: [
      { id: "session", label: "Session", used_percent: 27, resets_at: "2026-09-29T14:00:00Z", window_minutes: 300 },
      { id: "weekly", label: "Weekly", used_percent: 64, resets_at: "2026-10-02T17:00:00Z", window_minutes: 10080 },
    ],
    stale: false,
    refreshing: false,
    fetched_at: "2026-09-29T11:58:00Z",
    checked_at: "2026-09-29T11:58:00Z",
    next_refresh_at: "2026-09-29T12:03:00Z",
    ...overrides,
  };
}

test("headline window is the one closest to its cap", () => {
  assert.equal(headlineWindow(account(), NOW).id, "weekly");
  const tie = (weeklyReset, sessionReset) =>
    account({
      windows: [
        { id: "weekly", label: "Weekly", used_percent: 80, resets_at: weeklyReset, window_minutes: 10080 },
        { id: "session", label: "Session", used_percent: 80, resets_at: sessionReset, window_minutes: 300 },
      ],
    });
  // Ties go to whichever window resets sooner, whatever its length.
  assert.equal(headlineWindow(tie("2026-10-02T17:00:00Z", "2026-09-29T14:00:00Z"), NOW).id, "session");
  assert.equal(headlineWindow(tie("2026-09-29T12:10:00Z", "2026-09-29T16:50:00Z"), NOW).id, "weekly");
});

test("windows past their reset are never shown as current", () => {
  const expired = account({
    windows: [{ id: "session", label: "Session", used_percent: 91, resets_at: "2026-09-29T11:59:00Z", window_minutes: 300 }],
  });
  assert.deepEqual(openWindows(expired, NOW), []);
  assert.equal(headlineWindow(expired, NOW), null);
});

test("percentages floor and levels escalate", () => {
  assert.equal(formatPercent(99.6), "99%");
  assert.equal(formatPercent(-1), "0%");
  assert.equal(usageLevel(10), "low");
  assert.equal(usageLevel(50), "mid");
  assert.equal(usageLevel(80), "high");
  assert.equal(usageLevel(100), "full");
});

test("reset countdowns read naturally", () => {
  assert.equal(formatResetCountdown("2026-09-29T14:14:00Z", NOW), "Resets in 2h 14m");
  assert.equal(formatResetCountdown("2026-10-02T17:00:00Z", NOW), "Resets in 3d 5h");
  assert.equal(formatResetCountdown("2026-09-29T12:00:20Z", NOW), "Resets in <1m");
  assert.equal(formatResetCountdown("2026-09-29T11:00:00Z", NOW), "Resetting now");
  assert.equal(formatResetCountdown(null, NOW), "No reset time");
  assert.equal(formatDuration(3600), "1h");
});

test("compact labels only name profiles when a provider has several accounts", () => {
  const solo = account();
  assert.equal(compactAccountLabel(solo, [solo]), "Claude");
  const second = account({ key: "claude:bbbb", profiles: [{ label: "account2", path: "~/.claude-accounts/account2" }] });
  assert.equal(compactAccountLabel(solo, [solo, second]), "Claude · default");
  assert.equal(compactAccountLabel(second, [solo, second]), "Claude · account2");
});

test("stale and failing records never read as live", () => {
  assert.equal(isLive(account()), true);
  assert.equal(isLive(account({ status: "stale", stale: true })), false);
  assert.equal(isLive(account({ status: "expired" })), false);
  assert.equal(statusLabel(account({ status: "expired" })), "Sign-in expired");
  assert.equal(statusLabel(account({ refreshing: true })), "Refreshing…");
  assert.match(compactAriaLabel(account({ status: "stale", stale: true }), [account()], NOW), /64% of weekly limit used \(stale\)/);
  assert.match(compactAriaLabel(account({ status: "signed_out", windows: [] }), [], NOW), /Signed out/);
});

test("polling speeds up only while a probe is in flight", () => {
  assert.equal(usagePollDelay(null), 60_000);
  assert.equal(usagePollDelay({ accounts: [account()], generated_at: "", refresh_interval_seconds: 300 }), 60_000);
  assert.equal(usagePollDelay({ accounts: [account({ refreshing: true })], generated_at: "", refresh_interval_seconds: 300 }), 3_000);
  assert.equal(usagePollDelay({ accounts: [account({ status: "loading" })], generated_at: "", refresh_interval_seconds: 300 }), 3_000);
});

test("an unreachable backend downgrades every record from live", async () => {
  const { markUnreachable } = await import("../src/usage-display.ts");
  const snapshot = {
    accounts: [account(), account({ key: "b", status: "loading", windows: [] }), account({ key: "c", status: "expired", message: "Sign in." })],
    generated_at: "",
    refresh_interval_seconds: 300,
  };
  const [live, loading, expired] = markUnreachable(snapshot, "Backend offline.").accounts;
  assert.equal(isLive(live), false);
  assert.equal(live.status, "stale");
  assert.equal(live.stale, true);
  assert.equal(live.message, "Backend offline.");
  assert.equal(loading.status, "error");
  assert.equal(expired.status, "expired");
  assert.equal(expired.message, "Sign in.");
});

test("title-bar chips name the profile only when a provider has several accounts", async () => {
  const { chipLabel } = await import("../src/usage-display.ts");
  const solo = account();
  const codex = account({ key: "codex:cccc", provider: "codex", provider_name: "Codex" });
  assert.equal(chipLabel(solo, [solo, codex]), null);
  const second = account({ key: "claude:bbbb", profiles: [{ label: "account2", path: "~/.claude-accounts/account2" }] });
  assert.equal(chipLabel(solo, [solo, second, codex]), "default");
  assert.equal(chipLabel(second, [solo, second, codex]), "account2");
});

test("a refresh in flight never hides that the numbers are old", () => {
  assert.equal(statusLabel(account({ refreshing: true })), "Refreshing…");
  assert.equal(statusLabel(account({ status: "stale", stale: true, refreshing: true })), "Stale · refreshing…");
  assert.equal(statusLabel(account({ status: "expired", refreshing: true })), "Sign-in expired · refreshing…");
  assert.equal(statusLabel(account({ status: "loading", refreshing: true })), "Checking…");
});

test("a snapshot is live only while polls keep confirming it", async () => {
  const { presentSnapshot, SNAPSHOT_MAX_AGE_MS } = await import(MODULE);
  const snapshot = { accounts: [account()], generated_at: "", refresh_interval_seconds: 300 };
  const options = { receivedAt: NOW, now: NOW + 5_000, pollFailed: false, unreachableMessage: "Offline." };
  assert.equal(presentSnapshot(null, options), null);
  assert.equal(isLive(presentSnapshot(snapshot, options).accounts[0]), true);
  // The app slept, or a poll hung: the same answer is no longer current.
  const aged = presentSnapshot(snapshot, { ...options, now: NOW + SNAPSHOT_MAX_AGE_MS + 1 });
  assert.equal(isLive(aged.accounts[0]), false);
  assert.equal(aged.accounts[0].stale, true);
  const failed = presentSnapshot(snapshot, { ...options, pollFailed: true });
  assert.equal(failed.accounts[0].message, "Offline.");
  assert.equal(isLive(presentSnapshot(snapshot, { ...options, receivedAt: null }).accounts[0]), false);
});

test("chip bars always include the window the percentage comes from", async () => {
  const { chipWindows } = await import(MODULE);
  const fable = { id: "weekly:fable", label: "Weekly · Fable", used_percent: 100, resets_at: "2026-10-02T17:00:00Z", window_minutes: 10080 };
  const bars = chipWindows(account({ windows: [...account().windows, fable] }), NOW);
  assert.deepEqual(bars.map((window) => window.id), ["session", "weekly:fable"]);
  assert.deepEqual(chipWindows(account(), NOW).map((window) => window.id), ["session", "weekly"]);
  assert.deepEqual(chipWindows(account({ windows: [] }), NOW), []);
});

test("an unreachable host promises no next check", async () => {
  const { markUnreachable } = await import(MODULE);
  const snapshot = { accounts: [account(), account({ key: "c", status: "expired" })], generated_at: "", refresh_interval_seconds: 300 };
  assert.deepEqual(markUnreachable(snapshot, "Offline.").accounts.map((item) => item.next_refresh_at), [null, null]);
});

test("host timestamps are read on the host's clock", async () => {
  const { clockOffsetMs } = await import(MODULE);
  const snapshot = { accounts: [], generated_at: "2026-09-29T12:00:00Z", refresh_interval_seconds: 300 };
  // This device runs 3 minutes fast.
  assert.equal(clockOffsetMs(snapshot, NOW + 180_000), -180_000);
  assert.equal(clockOffsetMs(null, NOW), 0);
  assert.equal(clockOffsetMs({ ...snapshot, generated_at: "garbage" }, NOW), 0);
  const nearReset = account({
    windows: [{ id: "session", label: "Session", used_percent: 98, resets_at: "2026-09-29T12:02:00Z", window_minutes: 300 }],
  });
  const deviceNow = NOW + 180_000;
  assert.equal(openWindows(nearReset, deviceNow).length, 0); // naive device clock drops it
  assert.equal(openWindows(nearReset, deviceNow + clockOffsetMs(snapshot, deviceNow)).length, 1);
});
