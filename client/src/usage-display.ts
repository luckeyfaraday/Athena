// Display helpers for subscription usage records served by the backend's
// /usage/accounts. Pure functions only, so they can be unit tested in Node.

export type UsageStatus =
  | "ok"
  | "loading"
  | "stale"
  | "expired"
  | "signed_out"
  | "rate_limited"
  | "error"
  | "unsupported";

export type UsageWindow = {
  id: string;
  label: string;
  used_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
};

export type UsageAccount = {
  key: string;
  provider: string;
  provider_name: string;
  account: {
    email: string | null;
    display_name: string | null;
    organization: string | null;
    identified: boolean;
  };
  profiles: { label: string; path: string }[];
  plan: string | null;
  status: UsageStatus;
  message: string | null;
  windows: UsageWindow[];
  stale: boolean;
  refreshing: boolean;
  fetched_at: string | null;
  checked_at: string | null;
  next_refresh_at: string | null;
};

export type UsageSnapshot = {
  accounts: UsageAccount[];
  generated_at: string;
  refresh_interval_seconds: number;
};

export type UsageLevel = "low" | "mid" | "high" | "full";

export const USAGE_POLL_MS = 60_000;
export const USAGE_BUSY_POLL_MS = 3_000;
/** A snapshot not re-confirmed by a poll within this long is no longer shown as live. */
export const SNAPSHOT_MAX_AGE_MS = USAGE_POLL_MS + 30_000;

/** The window closest to its cap: the one that will stop the user first. */
export function headlineWindow(account: UsageAccount, now = Date.now()): UsageWindow | null {
  const open = openWindows(account, now);
  if (open.length === 0) return null;
  return open.reduce((best, window) => {
    if (window.used_percent !== best.used_percent) return window.used_percent > best.used_percent ? window : best;
    // Ties go to the window that resets sooner.
    return resetTime(window) < resetTime(best) ? window : best;
  });
}

function resetTime(window: UsageWindow): number {
  const time = window.resets_at ? Date.parse(window.resets_at) : NaN;
  return Number.isFinite(time) ? time : Infinity;
}

/** Windows still in effect. A window past its reset describes a period that is over. */
export function openWindows(account: UsageAccount, now = Date.now()): UsageWindow[] {
  return account.windows.filter((window) => !window.resets_at || Date.parse(window.resets_at) > now);
}

export function usageLevel(percent: number): UsageLevel {
  if (percent >= 100) return "full";
  if (percent >= 80) return "high";
  if (percent >= 50) return "mid";
  return "low";
}

export function formatPercent(percent: number): string {
  // Floor like the provider CLIs do, so 99.6% never reads as a spent 100%.
  return `${Math.floor(Math.max(0, Math.min(100, percent)))}%`;
}

export function formatResetCountdown(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return "No reset time";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "No reset time";
  const seconds = Math.round((target - now) / 1000);
  if (seconds <= 0) return "Resetting now";
  return `Resets in ${formatDuration(seconds)}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  return `${formatDuration(seconds)} ago`;
}

const STATUS_LABELS: Record<UsageStatus, string> = {
  ok: "Live",
  loading: "Checking…",
  stale: "Stale",
  expired: "Sign-in expired",
  signed_out: "Signed out",
  rate_limited: "Rate limited",
  error: "Unavailable",
  unsupported: "Not supported",
};

export function statusLabel(account: UsageAccount): string {
  const label = STATUS_LABELS[account.status] ?? account.status;
  if (!account.refreshing || account.status === "loading") return label;
  // A refresh in flight must not hide that the numbers on screen are old.
  return isLive(account) ? "Refreshing…" : `${label} · refreshing…`;
}

/** Whether the numbers on screen are a live reading rather than a leftover. */
export function isLive(account: UsageAccount): boolean {
  return account.status === "ok" && !account.stale;
}

/**
 * What tells a provider's accounts apart: the profile label (emails can collide
 * across organizations, profile labels cannot). Null when the provider has only
 * one account, which the provider's name identifies.
 */
export function accountLabel(account: UsageAccount, accounts: UsageAccount[]): string | null {
  const siblings = accounts.filter((other) => other.provider === account.provider);
  if (siblings.length <= 1) return null;
  return account.profiles[0]?.label ?? shortEmail(account.account.email) ?? "account";
}

export function accountTitle(account: UsageAccount): string {
  return account.account.email ?? account.account.display_name ?? account.profiles[0]?.label ?? "Unknown account";
}

export function shortEmail(email: string | null): string | null {
  return email ? email.split("@")[0] : null;
}

export function usagePollDelay(snapshot: UsageSnapshot | null): number {
  const busy = snapshot?.accounts.some((account) => account.refreshing || account.status === "loading");
  return busy ? USAGE_BUSY_POLL_MS : USAGE_POLL_MS;
}

/** How loudly a gauge flags its account: old or throttled numbers warn, unreadable accounts are danger. */
export type UsageAttention = "none" | "loading" | "warn" | "danger";

export function usageAttention(account: UsageAccount): UsageAttention {
  if (account.status === "loading") return "loading";
  if (isLive(account)) return "none";
  if (account.status === "ok" || account.status === "stale" || account.status === "rate_limited" || account.status === "unsupported") return "warn";
  return "danger";
}

const attentionSeverity: Record<UsageAttention, number> = { none: 0, loading: 1, warn: 2, danger: 3 };

/** The loudest attention among accounts, for a "+N" count standing in for hidden gauges. */
export function worstAttention(accounts: UsageAccount[]): UsageAttention {
  return accounts.reduce<UsageAttention>((worst, account) => {
    const attention = usageAttention(account);
    return attentionSeverity[attention] > attentionSeverity[worst] ? attention : worst;
  }, "none");
}

/**
 * The account a provider's control opens: the one that needs attention (an
 * unreadable account before old numbers), otherwise the one closest to its cap.
 * Ties keep the snapshot's order.
 */
export function preferredAccount(accounts: UsageAccount[], now = Date.now()): UsageAccount | null {
  let best: UsageAccount | null = null;
  let bestRank: [number, number] = [-1, -1];
  for (const account of accounts) {
    const attention = usageAttention(account);
    const severity = attention === "danger" || attention === "warn" ? attentionSeverity[attention] : 0;
    const rank: [number, number] = [severity, headlineWindow(account, now)?.used_percent ?? -1];
    if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
      best = account;
      bestRank = rank;
    }
  }
  return best;
}

/** Gauges a provider shows in the title bar; the rest are summed up as "+N". */
export const MAX_TITLE_BAR_GAUGES = 3;

export function visibleGauges(accounts: UsageAccount[], max = MAX_TITLE_BAR_GAUGES): { shown: UsageAccount[]; hidden: UsageAccount[] } {
  return accounts.length <= max
    ? { shown: accounts, hidden: [] }
    : { shown: accounts.slice(0, max), hidden: accounts.slice(max) };
}

/**
 * Length of a ring arc for a percentage, drawn with butt caps so the painted
 * arc is exactly the value: nothing at 0%, a closed ring only at 100%.
 */
export function ringArcLength(percent: number, circumference: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return (Math.min(100, percent) / 100) * circumference;
}

const NO_ACTIVE_WINDOW = "No active window";

/**
 * The number a gauge shows: the headline percentage, marked as a last-known
 * value when the reading is not live, or a dash when a live account has no
 * open window. Null when there is nothing to show but the account's status.
 */
export function gaugeValue(account: UsageAccount, now = Date.now()): { text: string; live: boolean; title: string } | null {
  const window = headlineWindow(account, now);
  if (window) {
    const live = isLive(account);
    return {
      text: formatPercent(window.used_percent),
      live,
      title: live
        ? `${window.label} limit`
        : `Last known ${window.label.toLowerCase()} reading (${statusLabel(account).toLowerCase()})`,
    };
  }
  if (account.status === "ok") return { text: "—", live: true, title: NO_ACTIVE_WINDOW };
  return null;
}

export type UsageProviderGroup = { provider: string; providerName: string; accounts: UsageAccount[] };

/** One title-bar control per provider, in the order providers first appear. */
export function groupByProvider(accounts: UsageAccount[]): UsageProviderGroup[] {
  const groups = new Map<string, UsageProviderGroup>();
  for (const account of accounts) {
    const group = groups.get(account.provider);
    if (group) group.accounts.push(account);
    else groups.set(account.provider, { provider: account.provider, providerName: account.provider_name, accounts: [account] });
  }
  return [...groups.values()];
}

/**
 * The windows a gauge draws: the headline window as the outer ring and, when
 * another window is open, the next most-used one as the inner ring.
 */
export function gaugeWindows(account: UsageAccount, now = Date.now()): { outer: UsageWindow | null; inner: UsageWindow | null } {
  const outer = headlineWindow(account, now);
  if (!outer) return { outer: null, inner: null };
  const others = openWindows(account, now).filter((window) => window !== outer);
  const inner = others.reduce<UsageWindow | null>((best, window) => (!best || window.used_percent > best.used_percent ? window : best), null);
  return { outer, inner };
}

/** One plain-language line per account, for the provider control's tooltip and accessible name. */
export function accountSummaryLine(account: UsageAccount, accounts: UsageAccount[], now = Date.now()): string {
  const name = accountLabel(account, accounts) ?? account.provider_name;
  const window = headlineWindow(account, now);
  if (!window) return `${name}: ${account.status === "ok" && !account.refreshing ? NO_ACTIVE_WINDOW : statusLabel(account)}`;
  const freshness = isLive(account) ? "" : ` (${statusLabel(account).toLowerCase()})`;
  return `${name}: ${formatPercent(window.used_percent)} of ${window.label.toLowerCase()} limit used${freshness}, ${formatResetCountdown(window.resets_at, now).toLowerCase()}`;
}

export function groupDescription(group: UsageProviderGroup, accounts: UsageAccount[], now = Date.now()): string {
  const lines = group.accounts.map((account) => accountSummaryLine(account, accounts, now));
  return `${group.providerName} usage\n${lines.join("\n")}\nClick for details.`;
}

/**
 * When Athena's backend stops answering, the last snapshot is no longer a live
 * reading: every record is downgraded so nothing on screen claims to be current.
 */
export function markUnreachable(snapshot: UsageSnapshot, message: string): UsageSnapshot {
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => {
      const current = account.status === "ok" || account.status === "loading";
      return {
        ...account,
        refreshing: false,
        stale: account.windows.length > 0,
        status: current ? (account.windows.length > 0 ? "stale" : "error") : account.status,
        message: current ? message : account.message,
        // Nothing can promise a next check while the host is not answering.
        next_refresh_at: null,
      };
    }),
  };
}

/**
 * What to render for the last snapshot received. The backend's own freshness
 * flags only hold at the moment it answered, so a snapshot that has not been
 * re-confirmed recently (the app slept, a poll hung, the backend went away) is
 * downgraded. That age is measured on this device's clock only.
 */
export function presentSnapshot(
  snapshot: UsageSnapshot | null,
  options: { receivedAt: number | null; now: number; pollFailed: boolean; unreachableMessage: string },
): UsageSnapshot | null {
  if (!snapshot) return null;
  if (options.pollFailed) return markUnreachable(snapshot, options.unreachableMessage);
  if (options.receivedAt === null || options.now - options.receivedAt > SNAPSHOT_MAX_AGE_MS) {
    return markUnreachable(snapshot, "Waiting for a fresh reading; these are the last values received.");
  }
  return snapshot;
}

/**
 * Host clock minus this device's clock, estimated from a snapshot's
 * generated_at. Reset times and "updated" ages come from the host, so they are
 * compared against `now + offset`; freshness of the snapshot itself uses this
 * device's clock alone.
 */
export function clockOffsetMs(snapshot: UsageSnapshot | null, receivedAt: number | null): number {
  if (!snapshot || receivedAt === null) return 0;
  const generated = Date.parse(snapshot.generated_at);
  return Number.isFinite(generated) ? generated - receivedAt : 0;
}
