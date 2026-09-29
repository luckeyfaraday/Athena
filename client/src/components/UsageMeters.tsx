import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { BackendClient } from "../api";
import { ClaudeIcon, OpenAIIcon } from "./BrandIcons";
import {
  accountTitle,
  chipLabel,
  compactAccountLabel,
  compactAriaLabel,
  formatAge,
  formatDuration,
  formatPercent,
  formatResetCountdown,
  headlineWindow,
  isLive,
  openWindows,
  presentSnapshot,
  statusLabel,
  usageLevel,
  usagePollDelay,
  type UsageAccount,
  type UsageSnapshot,
  type UsageWindow,
} from "../usage-display";

// Subscription quota chips for the title bar, opening a detail panel. Every
// surface reads the backend's shared cache; polling here never reaches a
// provider directly.

function useUsage(client: BackendClient | null) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const rescheduleRef = useRef<((delayMs: number) => void) | null>(null);

  useEffect(() => {
    // A new client means a new backend: nothing from the old one carries over.
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
      let next: UsageSnapshot | null = null;
      try {
        next = await client.usageAccounts();
        if (!active) return;
        setSnapshot(next);
        setReceivedAt(Date.now());
        setPollError(null);
      } catch (loadError) {
        if (active) setPollError(messageOf(loadError));
      } finally {
        loading = false;
      }
      if (active) timer = window.setTimeout(() => void load(), usagePollDelay(next));
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
  }, [client]);

  const refresh = useCallback(
    async (accountKey?: string) => {
      if (!client) return;
      setRefreshing(true);
      setRefreshError(null);
      try {
        const next = await client.refreshUsage(accountKey ? { accountKey } : {});
        setSnapshot(next);
        setReceivedAt(Date.now());
        setPollError(null);
        // Keep following a probe that is still running instead of idling for a minute.
        rescheduleRef.current?.(usagePollDelay(next));
      } catch (error) {
        setRefreshError(messageOf(error));
      } finally {
        setRefreshing(false);
      }
    },
    [client],
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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = presentSnapshot(received, {
    receivedAt,
    now,
    pollFailed: pollError !== null,
    unreachableMessage: "Couldn't reach Athena's backend; showing the last values it reported.",
  });
  const accounts = snapshot?.accounts ?? [];
  const error = pollError ? `Backend error: ${pollError}` : refreshError ? `Refresh failed: ${refreshError}` : null;

  // Nothing to show before the first answer or without any CLI login; the
  // title bar's backend indicator already covers an unreachable backend.
  if (!client || accounts.length === 0) return null;

  const selected = accounts.find((account) => account.key === openKey) ?? null;
  const close = () => {
    setOpenKey(null);
    triggerRef.current?.focus();
  };

  return (
    <div className="titleUsage" role="group" aria-label="Subscription usage">
      {accounts.map((account) => (
        <UsageChip
          key={account.key}
          account={account}
          accounts={accounts}
          now={now}
          expanded={openKey === account.key}
          onOpen={(button) => {
            triggerRef.current = button;
            setOpenKey(openKey === account.key ? null : account.key);
          }}
        />
      ))}
      {selected && (
        <UsagePanel
          account={selected}
          accounts={accounts}
          now={now}
          refreshing={refreshing}
          error={error}
          onSelect={setOpenKey}
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

function UsageChip({
  account,
  accounts,
  now,
  expanded,
  onOpen,
}: {
  account: UsageAccount;
  accounts: UsageAccount[];
  now: number;
  expanded: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const headline = headlineWindow(account, now);
  const windows = openWindows(account, now).slice(0, 2);
  const label = chipLabel(account, accounts);
  const description = compactAriaLabel(account, accounts, now);
  return (
    <button
      type="button"
      className={`usageChip${isLive(account) ? "" : " notLive"}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={description}
      title={description}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <ProviderMark provider={account.provider} size={11} />
      {label && <span className="usageChipLabel">{label}</span>}
      <strong className={headline ? `usageLevel-${usageLevel(headline.used_percent)}` : `usageChipState status-${account.status}`}>
        {headline ? formatPercent(headline.used_percent) : account.status === "loading" ? "…" : "!"}
      </strong>
      {windows.length > 0 && (
        <span className="usageChipTracks" aria-hidden="true">
          {windows.map((window) => (
            <span key={window.id} className="usageTrack">
              <span className={`usageFill usageLevel-${usageLevel(window.used_percent)}`} style={{ width: `${window.used_percent}%` }} />
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function UsagePanel({
  account,
  accounts,
  now,
  refreshing,
  error,
  onSelect,
  onRefresh,
  onClose,
}: {
  account: UsageAccount;
  accounts: UsageAccount[];
  now: number;
  refreshing: boolean;
  error: string | null;
  onSelect: (key: string) => void;
  onRefresh: (accountKey?: string) => Promise<void>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".usageChip")) return;
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
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && (event.target as Element).getAttribute("role") === "tab") {
      const index = accounts.findIndex((item) => item.key === account.key);
      const next = accounts[(index + (event.key === "ArrowRight" ? 1 : accounts.length - 1)) % accounts.length];
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
        <span className="usagePanelTitle">Subscription usage</span>
        <div>
          <button
            type="button"
            className="usageIconButton"
            onClick={() => void onRefresh()}
            disabled={busy}
            aria-label="Refresh all accounts"
            title="Refresh all accounts"
          >
            <RefreshCw size={13} className={busy ? "spinning" : undefined} />
          </button>
          <button type="button" className="usageIconButton" onClick={onClose} aria-label="Close usage details">
            <X size={13} />
          </button>
        </div>
      </header>

      {accounts.length > 1 && (
        <div className="usageTabs" role="tablist" aria-label="Accounts">
          {accounts.map((item) => (
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
              <ProviderMark provider={item.provider} size={11} />
              {compactAccountLabel(item, accounts)}
            </button>
          ))}
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

        <p className={`usageStatus status-${account.status}${account.stale ? " stale" : ""}`} role="status">
          <i aria-hidden="true" />
          {statusLabel(account)}
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
          account.status === "loading" && <p className="usageEmpty">Reading quota windows…</p>
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
          <button type="button" className="usageRefresh" onClick={() => void onRefresh(account.key)} disabled={busy}>
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
