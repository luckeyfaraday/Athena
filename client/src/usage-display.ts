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

/** Up to two bars for a chip, always including the window its percentage comes from. */
export function chipWindows(account: UsageAccount, now = Date.now()): UsageWindow[] {
  const open = openWindows(account, now);
  const headline = headlineWindow(account, now);
  const bars = open.slice(0, 2);
  if (headline && !bars.includes(headline)) bars[bars.length - 1] = headline;
  return bars;
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
 * Short name for compact bars. A provider with one account shows just the
 * provider; several accounts add the profile label (emails can collide across
 * organizations, profile labels cannot).
 */
export function compactAccountLabel(account: UsageAccount, accounts: UsageAccount[]): string {
  const profile = chipLabel(account, accounts);
  return profile ? `${account.provider_name} · ${profile}` : account.provider_name;
}

/** Label beside a chip's provider mark: only needed when a provider has several accounts. */
export function chipLabel(account: UsageAccount, accounts: UsageAccount[]): string | null {
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

/** Plain-language summary for the compact bar's accessible name. */
export function compactAriaLabel(account: UsageAccount, accounts: UsageAccount[], now = Date.now()): string {
  const name = compactAccountLabel(account, accounts);
  const window = headlineWindow(account, now);
  if (!window) return `${name}: ${statusLabel(account)}. Open usage details.`;
  const freshness = isLive(account) ? "" : ` (${statusLabel(account).toLowerCase()})`;
  return `${name}: ${formatPercent(window.used_percent)} of ${window.label.toLowerCase()} limit used${freshness}. ${formatResetCountdown(window.resets_at, now)}. Open usage details.`;
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
