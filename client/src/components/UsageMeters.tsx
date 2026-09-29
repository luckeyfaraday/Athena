import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { BackendClient } from "../api";
import { ClaudeIcon, OpenAIIcon } from "./BrandIcons";
import {
  accountLabel,
  accountTitle,
  clockOffsetMs,
  formatAge,
  formatDuration,
  formatPercent,
  formatResetCountdown,
  gaugeValue,
  gaugeWindows,
  groupByProvider,
  groupDescription,
  isLive,
  openWindows,
  preferredAccount,
  presentSnapshot,
  ringArcLength,
  statusLabel,
  usageAttention,
  usageLevel,
  usagePollDelay,
  visibleGauges,
  worstAttention,
  type UsageAccount,
  type UsageProviderGroup,
  type UsageSnapshot,
  type UsageWindow,
} from "../usage-display";

// Subscription quota gauges for the title bar, one control per provider,
// opening a detail panel. Every surface reads the backend's shared cache;
// polling here never reaches a provider directly.

// accountKey or provider name what failed to refresh; both null means every account.
type RefreshFailure = { accountKey: string | null; provider: string | null; message: string };
type RefreshScope = { accountKey?: string; provider?: string };

function useUsage(client: BackendClient | null) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<RefreshFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const rescheduleRef = useRef<((delayMs: number) => void) | null>(null);
  // Responses are applied in the order their requests were issued, so a poll
  // sent before a refresh cannot land afterwards and undo it, and nothing
  // requested from a previous backend lands after the client changes.
  const issuedRef = useRef(0);
  const appliedRef = useRef(0);
  const latestRef = useRef<UsageSnapshot | null>(null);

  const apply = useCallback((sequence: number, next: UsageSnapshot) => {
    if (sequence < appliedRef.current) return false;
    appliedRef.current = sequence;
    latestRef.current = next;
    setSnapshot(next);
    setReceivedAt(Date.now());
    setPollError(null);
    return true;
  }, []);

  useEffect(() => {
    // A new client means a new backend: nothing from the old one carries over.
    appliedRef.current = ++issuedRef.current;
    latestRef.current = null;
    setSnapshot(null);
    setReceivedAt(null);
    setPollError(null);
    setRefreshError(null);
    if (!client) return;
    let active = true;
    let loading = false;
    let timer: number | undefined;
    const load = async () => {
      window.clearTimeout(timer);
      if (loading) return;
      loading = true;
      const sequence = ++issuedRef.current;
      try {
        const next = await client.usageAccounts();
        if (active && apply(sequence, next)) setRefreshError(null);
      } catch (loadError) {
        if (active && sequence >= appliedRef.current) {
          appliedRef.current = sequence;
          setPollError(messageOf(loadError));
        }
      } finally {
        loading = false;
      }
      if (active) timer = window.setTimeout(() => void load(), usagePollDelay(latestRef.current));
    };
    rescheduleRef.current = (delayMs) => {
      if (loading) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), delayMs);
    };
    void load();
    return () => {
      active = false;
      rescheduleRef.current = null;
      window.clearTimeout(timer);
    };
  }, [client, apply]);

  const refresh = useCallback(
    async (scope: RefreshScope = {}) => {
      if (!client) return;
      setRefreshing(true);
      setRefreshError(null);
      const sequence = ++issuedRef.current;
      try {
        const next = await client.refreshUsage(scope);
        // Keep following a probe that is still running instead of idling for a minute.
        if (apply(sequence, next)) rescheduleRef.current?.(usagePollDelay(next));
      } catch (error) {
        if (sequence >= appliedRef.current) {
          setRefreshError({ accountKey: scope.accountKey ?? null, provider: scope.provider ?? null, message: messageOf(error) });
        }
      } finally {
        setRefreshing(false);
      }
    },
    [client, apply],
  );

  return { snapshot, receivedAt, pollError, refreshError, refreshing, refresh };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, intervalMs);
    // Coming back from sleep, countdowns and staleness must not wait for the next tick.
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs]);
  return now;
}

export function UsageMeters({ client }: { client: BackendClient | null }) {
  const { snapshot: received, receivedAt, pollError, refreshError, refreshing, refresh } = useUsage(client);
  const now = useNow(30_000);
  // The panel belongs to the provider control that opened it; `key` is the account it shows.
  const [open, setOpen] = useState<{ provider: string; key: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = presentSnapshot(received, {
    receivedAt,
    now,
    pollFailed: pollError !== null,
    unreachableMessage: "Couldn't reach Athena's backend; showing the last values it reported.",
  });
  // Reset times and ages are backend timestamps; read them on the backend's clock.
  const hostNow = now + clockOffsetMs(received, receivedAt);
  const accounts = snapshot?.accounts ?? [];
  const groups = groupByProvider(accounts);
  const openGroup = open ? groups.find((group) => group.provider === open.provider) ?? null : null;
  const selected = open && openGroup ? openGroup.accounts.find((account) => account.key === open.key) ?? null : null;

  // An account that drops out of the snapshot closes its panel for good,
  // rather than leaving a closed-but-selected panel to pop back open later.
  useEffect(() => {
    if (open !== null && received !== null && !selected) setOpen(null);
  }, [open, received, selected]);

  // Nothing to show before the first answer or without any CLI login; the
  // title bar's backend indicator already covers an unreachable backend.
  if (!client || accounts.length === 0) return null;

  const errorFor = (account: UsageAccount): string | null => {
    if (pollError) return `Backend error: ${pollError}`;
    if (!refreshError) return null;
    const covers = refreshError.accountKey
      ? refreshError.accountKey === account.key
      : refreshError.provider === null || refreshError.provider === account.provider;
    return covers ? `Refresh failed: ${refreshError.message}` : null;
  };
  const close = () => {
    setOpen(null);
    triggerRef.current?.focus();
  };
  // More than a few gauges in all: their percentages give way first when the window narrows.
  const crowded = groups.reduce((total, group) => total + visibleGauges(group.accounts).shown.length, 0) > 3;

  return (
    <div className="titleUsage" role="group" aria-label="Subscription usage" data-crowded={crowded || undefined}>
      {groups.map((group) => (
        <UsageGroupButton
          key={group.provider}
          group={group}
          accounts={accounts}
          now={hostNow}
          expanded={openGroup?.provider === group.provider}
          onOpen={(button) => {
            triggerRef.current = button;
            if (open?.provider === group.provider) {
              setOpen(null);
              return;
            }
            const account = preferredAccount(group.accounts, hostNow) ?? group.accounts[0];
            setOpen({ provider: group.provider, key: account.key });
          }}
        />
      ))}
      {selected && openGroup && (
        <UsagePanel
          account={selected}
          group={openGroup}
          now={hostNow}
          refreshing={refreshing}
          error={errorFor(selected)}
          onSelect={(key) => setOpen({ provider: openGroup.provider, key })}
          onRefresh={refresh}
          onClose={close}
        />
      )}
    </div>
  );
}

function ProviderMark({ provider, size = 12 }: { provider: string; size?: number }) {
  if (provider === "claude") return <ClaudeIcon size={size} aria-hidden="true" />;
  if (provider === "codex") return <OpenAIIcon size={size} aria-hidden="true" />;
  return <span className="usageMarkFallback" aria-hidden="true" />;
}

function UsageGroupButton({
  group,
  accounts,
  now,
  expanded,
  onOpen,
}: {
  group: UsageProviderGroup;
  accounts: UsageAccount[];
  now: number;
  expanded: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const description = groupDescription(group, accounts, now);
  const { shown, hidden } = visibleGauges(group.accounts);
  return (
    <button
      type="button"
      className="usageGroup"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={description}
      title={description}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <ProviderMark provider={group.provider} size={12} />
      <span className="usageGauges">
        {shown.map((account) => <UsageGauge key={account.key} account={account} now={now} showValue />)}
        {hidden.length > 0 && (
          <span className={`usageMore attention-${worstAttention(hidden)}`} aria-hidden="true">+{hidden.length}</span>
        )}
      </span>
    </button>
  );
}

const outerRadius = 7.25;
const innerRadius = 3.75;
// The status dot sits in a notch cut out of the rings (an SVG mask), so it
// reads the same on any background: title bar, hover fill, or panel row.
const dot = { x: 15.25, y: 2.75, radius: 2.5, cutout: 3.9 };

// Concentric rings: the outer one is the window closest to its cap (the
// percentage shown beside it), the inner one the account's other open window.
// Accounts whose numbers are not live draw faded rings and carry a status dot.
function UsageGauge({ account, now, showValue = false }: { account: UsageAccount; now: number; showValue?: boolean }) {
  const { outer, inner } = gaugeWindows(account, now);
  const attention = usageAttention(account);
  const flagged = attention !== "none";
  const maskId = `usage-gauge-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const value = showValue ? gaugeValue(account, now) : null;
  return (
    <span className={`usageGauge attention-${attention}${isLive(account) ? "" : " notLive"}`}>
      <svg className="usageRing" viewBox="0 0 18 18" aria-hidden="true">
        {flagged && (
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="white" />
            <circle cx={dot.x} cy={dot.y} r={dot.cutout} fill="black" />
          </mask>
        )}
        <g mask={flagged ? `url(#${maskId})` : undefined}>
          <circle className="usageRingTrack" cx="9" cy="9" r={outerRadius} />
          {outer && <RingArc radius={outerRadius} window={outer} />}
          {inner && <circle className="usageRingTrack inner" cx="9" cy="9" r={innerRadius} />}
          {inner && <RingArc radius={innerRadius} window={inner} inner />}
        </g>
        {flagged && <circle className="usageGaugeDot" cx={dot.x} cy={dot.y} r={dot.radius} />}
      </svg>
      {value && (
        <strong
          className={value.live && outer ? `usageGaugeValue usageLevel-${usageLevel(outer.used_percent)}` : "usageGaugeValue muted"}
          title={value.title}
        >
          {value.text}
        </strong>
      )}
    </span>
  );
}

function RingArc({ radius, window, inner = false }: { radius: number; window: UsageWindow; inner?: boolean }) {
  const circumference = 2 * Math.PI * radius;
  const length = ringArcLength(window.used_percent, circumference);
  if (length === 0) return null;
  return (
    <circle
      className={`usageRingFill usageLevel-${usageLevel(window.used_percent)}${inner ? " inner" : ""}`}
      cx="9"
      cy="9"
      r={radius}
      strokeDasharray={`${length} ${circumference}`}
      transform="rotate(-90 9 9)"
    />
  );
}

function UsagePanel({
  account,
  group,
  now,
  refreshing,
  error,
  onSelect,
  onRefresh,
  onClose,
}: {
  account: UsageAccount;
  group: UsageProviderGroup;
  now: number;
  refreshing: boolean;
  error: string | null;
  onSelect: (key: string) => void;
  onRefresh: (scope?: RefreshScope) => Promise<void>;
  onClose: () => void;
}) {
  // Only the accounts of the provider whose control opened the panel.
  const accounts = group.accounts;
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".usageGroup")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (step !== 0 && (event.target as Element).getAttribute("role") === "tab") {
      event.preventDefault();
      const index = accounts.findIndex((item) => item.key === account.key);
      const next = accounts[(index + step + accounts.length) % accounts.length];
      onSelect(next.key);
      window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-usage-tab="${next.key}"]`)?.focus());
    }
  };

  const windows = openWindows(account, now);
  const busy = refreshing || account.refreshing;
  const titleId = `usage-title-${account.key.replace(/[^a-z0-9]/gi, "")}`;
  const nextCheck = account.next_refresh_at ? Math.max(0, (Date.parse(account.next_refresh_at) - now) / 1000) : null;

  return (
    <div className="usagePanel" role="dialog" aria-labelledby={titleId} tabIndex={-1} ref={panelRef} onKeyDown={onKeyDown}>
      <header className="usagePanelHead">
        <span className="usagePanelTitle">{group.providerName} usage</span>
        <div>
          <button
            type="button"
            className="usageIconButton"
            onClick={() => void onRefresh({ provider: group.provider })}
            disabled={busy}
            aria-label={`Refresh every ${group.providerName} account`}
            title={`Refresh every ${group.providerName} account`}
          >
            <RefreshCw size={13} className={busy ? "spinning" : undefined} />
          </button>
          <button type="button" className="usageIconButton" onClick={onClose} aria-label="Close usage details">
            <X size={13} />
          </button>
        </div>
      </header>

      {accounts.length > 1 && (
        <div className="usageTabs" role="tablist" aria-label="Accounts" aria-orientation="vertical">
          {accounts.map((item) => {
            const value = tabValue(item, now);
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                data-usage-tab={item.key}
                aria-selected={item.key === account.key}
                tabIndex={item.key === account.key ? 0 : -1}
                className={item.key === account.key ? "usageTab active" : "usageTab"}
                onClick={() => onSelect(item.key)}
              >
                <UsageGauge account={item} now={now} />
                <span className="usageTabLabel">
                  <span>{accountLabel(item, accounts) ?? item.provider_name}</span>
                </span>
                <span className={value.muted ? "usageTabValue muted" : "usageTabValue"} title={value.title}>{value.text}</span>
              </button>
            );
          })}
        </div>
      )}

      <section className="usageAccount" role="tabpanel" aria-labelledby={titleId}>
        <div className="usageAccountHead">
          <ProviderMark provider={account.provider} size={18} />
          <div>
            <strong id={titleId}>
              {account.provider_name}
              {account.plan && <span className="usagePlan">{account.plan}</span>}
            </strong>
            <span>{accountTitle(account)}</span>
            {account.account.organization && <small>{account.account.organization}</small>}
          </div>
        </div>

        <p className={`usageStatus status-${account.status}${account.stale ? " stale" : ""}`}>
          <i aria-hidden="true" />
          {/* Only the status is live; the ticking age would be re-announced every minute. */}
          <strong role="status">{statusLabel(account)}</strong>
          {account.fetched_at && <span> · updated {formatAge(account.fetched_at, now)}</span>}
        </p>
        {account.message && (
          <p className="usageMessage">
            <AlertTriangle size={12} aria-hidden="true" />
            {account.message}
          </p>
        )}

        {windows.length > 0 ? (
          <ul className={account.stale ? "usageWindows stale" : "usageWindows"}>
            {windows.map((window) => (
              <UsageWindowRow key={window.id} window={window} now={now} stale={account.stale} />
            ))}
          </ul>
        ) : (
          (account.status === "loading" || account.status === "ok") && (
            <p className="usageEmpty">
              {account.status === "loading" ? "Reading quota windows…" : "No quota window is open right now; the next check reads the new ones."}
            </p>
          )
        )}

        <dl className="usageProfiles">
          <dt>{account.profiles.length > 1 ? "Profiles" : "Profile"}</dt>
          {account.profiles.map((profile) => (
            <dd key={profile.path}>
              <strong>{profile.label}</strong> <code>{profile.path}</code>
            </dd>
          ))}
        </dl>

        <footer className="usagePanelFoot">
          <button type="button" className="usageRefresh" onClick={() => void onRefresh({ accountKey: account.key })} disabled={busy}>
            <RefreshCw size={12} className={busy ? "spinning" : undefined} aria-hidden="true" />
            {busy ? "Refreshing…" : "Refresh"}
          </button>
          <span>
            {nextCheck !== null && !busy ? `Next check in ${formatDuration(nextCheck)}` : ""}
          </span>
        </footer>
        {error && <p className="usageMessage">{error}</p>}
        <p className="usageFootnote">Provider-reported subscription limits. Local transcript token counts are not included.</p>
      </section>
    </div>
  );
}

// A live percentage; a status with its last-known percentage; "—" for a live
// account with no open window; otherwise the status alone.
function tabValue(account: UsageAccount, now: number): { text: string; muted: boolean; title?: string } {
  const value = gaugeValue(account, now);
  if (value?.live) return { text: value.text, muted: value.text === "—", title: value.title };
  if (value) return { text: `${statusLabel(account)} · ${value.text}`, muted: true, title: value.title };
  return { text: statusLabel(account), muted: true };
}

function UsageWindowRow({ window, now, stale }: { window: UsageWindow; now: number; stale: boolean }) {
  const percent = formatPercent(window.used_percent);
  const reset = formatResetCountdown(window.resets_at, now);
  return (
    <li className="usageWindow">
      <div className="usageWindowHead">
        <span>{window.label}</span>
        <strong className={`usageLevel-${usageLevel(window.used_percent)}`}>{percent}</strong>
      </div>
      <div
        className="usageTrack large"
        role="meter"
        aria-label={`${window.label} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(window.used_percent)}
        aria-valuetext={`${percent} used${stale ? ", last known value" : ""}. ${reset}`}
      >
        <span className={`usageFill usageLevel-${usageLevel(window.used_percent)}`} style={{ width: `${window.used_percent}%` }} />
      </div>
      <small>{reset}</small>
    </li>
  );
}
