import assert from "node:assert/strict";
import test from "node:test";

import {
  accountSummaryLine,
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

test("stale and failing records never read as live", () => {
  assert.equal(isLive(account()), true);
  assert.equal(isLive(account({ status: "stale", stale: true })), false);
  assert.equal(isLive(account({ status: "expired" })), false);
  assert.equal(statusLabel(account({ status: "expired" })), "Sign-in expired");
  assert.equal(statusLabel(account({ refreshing: true })), "Refreshing…");
  assert.match(accountSummaryLine(account({ status: "stale", stale: true }), [account()], NOW), /64% of weekly limit used \(stale\)/);
  assert.match(accountSummaryLine(account({ status: "signed_out", windows: [] }), [], NOW), /Signed out/);
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

test("accounts are named by profile only when a provider has several", async () => {
  const { accountLabel } = await import("../src/usage-display.ts");
  const solo = account();
  const codex = account({ key: "codex:cccc", provider: "codex", provider_name: "Codex" });
  assert.equal(accountLabel(solo, [solo, codex]), null);
  const second = account({ key: "claude:bbbb", profiles: [{ label: "account2", path: "~/.claude-accounts/account2" }] });
  assert.equal(accountLabel(solo, [solo, second, codex]), "default");
  assert.equal(accountLabel(second, [solo, second, codex]), "account2");
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

test("title-bar gauges group accounts by provider in first-seen order", async () => {
  const { groupByProvider } = await import(MODULE);
  const accounts = [
    account({ key: "codex:a", provider: "codex", provider_name: "Codex" }),
    account({ key: "claude:a" }),
    account({ key: "codex:b", provider: "codex", provider_name: "Codex" }),
  ];
  const groups = groupByProvider(accounts);
  assert.deepEqual(groups.map((group) => group.provider), ["codex", "claude"]);
  assert.deepEqual(groups[0].accounts.map((item) => item.key), ["codex:a", "codex:b"]);
  assert.equal(groups[0].providerName, "Codex");
  assert.deepEqual(groupByProvider([]), []);
});

test("gauge attention: old or throttled numbers warn, unreadable accounts are danger", async () => {
  const { usageAttention } = await import(MODULE);
  assert.equal(usageAttention(account()), "none");
  assert.equal(usageAttention(account({ status: "loading", windows: [] })), "loading");
  assert.equal(usageAttention(account({ status: "ok", stale: true })), "warn");
  assert.equal(usageAttention(account({ status: "stale", stale: true })), "warn");
  assert.equal(usageAttention(account({ status: "rate_limited" })), "warn");
  assert.equal(usageAttention(account({ status: "expired", windows: [] })), "danger");
  assert.equal(usageAttention(account({ status: "signed_out", windows: [] })), "danger");
  assert.equal(usageAttention(account({ status: "error", windows: [] })), "danger");
});

test("the outer ring is the headline window, the inner ring the next most used", async () => {
  const { gaugeWindows } = await import(MODULE);
  const { outer, inner } = gaugeWindows(account(), NOW);
  assert.equal(outer.id, "weekly");
  assert.equal(inner.id, "session");
  const single = gaugeWindows(account({ windows: [account().windows[0]] }), NOW);
  assert.equal(single.outer.id, "session");
  assert.equal(single.inner, null);
  assert.deepEqual(gaugeWindows(account({ windows: [] }), NOW), { outer: null, inner: null });
  // A window past its reset never draws a ring.
  const past = gaugeWindows(account({
    windows: [
      { id: "session", label: "Session", used_percent: 95, resets_at: "2026-09-29T11:00:00Z", window_minutes: 300 },
      { id: "weekly", label: "Weekly", used_percent: 10, resets_at: "2026-10-02T17:00:00Z", window_minutes: 10080 },
    ],
  }), NOW);
  assert.equal(past.outer.id, "weekly");
  assert.equal(past.inner, null);
});

test("the provider tooltip has one plain line per account, never a truncated label", async () => {
  const { groupByProvider, groupDescription, accountSummaryLine } = await import(MODULE);
  const accounts = [
    account({ key: "codex:work", provider: "codex", provider_name: "Codex", profiles: [{ label: "daily-driver", path: "~/.codex" }] }),
    account({ key: "codex:old", provider: "codex", provider_name: "Codex", status: "expired", windows: [], profiles: [{ label: "accounts-backup", path: "~/.codex-b" }] }),
  ];
  assert.equal(accountSummaryLine(accounts[0], accounts, NOW), "daily-driver: 64% of weekly limit used, resets in 3d 5h");
  assert.equal(accountSummaryLine(accounts[1], accounts, NOW), "accounts-backup: Sign-in expired");
  // A provider's only account is named by the provider.
  assert.match(accountSummaryLine(account(), [account()], NOW), /^Claude: 64% of weekly limit used/);
  const [codex] = groupByProvider(accounts);
  assert.equal(
    groupDescription(codex, accounts, NOW),
    "Codex usage\ndaily-driver: 64% of weekly limit used, resets in 3d 5h\naccounts-backup: Sign-in expired\nClick for details.",
  );
});

test("ring arcs are exactly the value: nothing at 0%, closed only at 100%", async () => {
  const { ringArcLength } = await import(MODULE);
  const circumference = 2 * Math.PI * 7.25;
  assert.equal(ringArcLength(0, circumference), 0);
  assert.equal(ringArcLength(-5, circumference), 0);
  assert.equal(ringArcLength(Number.NaN, circumference), 0);
  assert.equal(ringArcLength(50, circumference), circumference / 2);
  assert.ok(Math.abs(ringArcLength(95, circumference) - 0.95 * circumference) < 1e-9);
  assert.ok(ringArcLength(95, circumference) < circumference, "95% leaves a visible gap");
  assert.equal(ringArcLength(100, circumference), circumference);
  assert.equal(ringArcLength(140, circumference), circumference);
});

test("gauge values: live percent, last-known percent muted, a dash for no open window", async () => {
  const { gaugeValue } = await import(MODULE);
  assert.deepEqual(gaugeValue(account(), NOW), { text: "64%", live: true, title: "Weekly limit" });
  // Old numbers keep their value, marked as not live.
  assert.deepEqual(gaugeValue(account({ status: "stale", stale: true }), NOW), {
    text: "64%",
    live: false,
    title: "Last known weekly reading (stale)",
  });
  assert.equal(gaugeValue(account({ status: "rate_limited" }), NOW).live, false);
  assert.deepEqual(gaugeValue(account({ windows: [] }), NOW), { text: "—", live: true, title: "No active window" });
  assert.equal(gaugeValue(account({ status: "expired", windows: [] }), NOW), null);
  assert.equal(gaugeValue(account({ status: "loading", windows: [] }), NOW), null);
});

test("a live account with no open window says so instead of just Live", () => {
  assert.equal(accountSummaryLine(account({ windows: [] }), [account()], NOW), "Claude: No active window");
  assert.equal(accountSummaryLine(account({ windows: [], refreshing: true }), [account()], NOW), "Claude: Refreshing…");
});

test("a provider control opens the account that needs attention, else the one closest to its cap", async () => {
  const { preferredAccount } = await import(MODULE);
  const low = account({ key: "a", windows: [{ id: "s", label: "Session", used_percent: 10, resets_at: null, window_minutes: 300 }] });
  const high = account({ key: "b", windows: [{ id: "s", label: "Session", used_percent: 90, resets_at: null, window_minutes: 300 }] });
  const stale = account({ key: "c", status: "stale", stale: true });
  const expired = account({ key: "d", status: "expired", windows: [] });
  const loading = account({ key: "e", status: "loading", windows: [] });
  assert.equal(preferredAccount([low, high], NOW).key, "b");
  assert.equal(preferredAccount([low, high, stale], NOW).key, "c");
  assert.equal(preferredAccount([stale, high, expired], NOW).key, "d", "an unreadable account before old numbers");
  assert.equal(preferredAccount([low, loading], NOW).key, "a", "a first check in flight is not a problem");
  assert.equal(preferredAccount([low, account({ key: "f", windows: low.windows })], NOW).key, "a", "ties keep snapshot order");
  assert.equal(preferredAccount([], NOW), null);
});

test("the title bar caps gauges per provider and counts the rest, flagging the worst hidden one", async () => {
  const { visibleGauges, worstAttention, MAX_TITLE_BAR_GAUGES } = await import(MODULE);
  const many = Array.from({ length: 6 }, (_, index) => account({ key: `codex:${index}` }));
  assert.equal(MAX_TITLE_BAR_GAUGES, 3);
  const { shown, hidden } = visibleGauges(many);
  assert.deepEqual(shown.map((item) => item.key), ["codex:0", "codex:1", "codex:2"]);
  assert.deepEqual(hidden.map((item) => item.key), ["codex:3", "codex:4", "codex:5"]);
  assert.deepEqual(visibleGauges(many.slice(0, 3)).hidden, []);
  assert.equal(worstAttention([]), "none");
  assert.equal(worstAttention([account(), account({ status: "stale", stale: true })]), "warn");
  assert.equal(worstAttention([account({ status: "stale", stale: true }), account({ status: "signed_out", windows: [] })]), "danger");
  assert.equal(worstAttention([account({ status: "loading", windows: [] })]), "loading");
});
