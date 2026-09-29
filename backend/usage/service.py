"""Shared, account-keyed cache of subscription usage windows.

Every consumer (desktop UI, mobile proxy, CLI) reads the same in-memory
records through ``snapshot()``, which never blocks on a provider: it serves
what is cached and schedules background probes for accounts that are due.
Upstream calls therefore happen at most once per refresh interval per account,
no matter how many clients poll or how often.

Records are keyed by provider plus a hash of the account's stable identity,
not by config home. Two homes signed into one account share a record; a home
that signs into a different account gets a fresh record, and a record whose
account is no longer signed in anywhere is dropped along with its windows.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from .base import AccountIdentity, ProbeResult, ProviderHome, UsageAdapter, UsageWindow, iso

REFRESH_INTERVAL_ENV = "CONTEXT_WORKSPACE_USAGE_REFRESH_SECONDS"
DEFAULT_REFRESH_INTERVAL_SECONDS = 300.0
MIN_REFRESH_INTERVAL_SECONDS = 60.0
# A manual refresh inside this window of the last check is served from cache.
MANUAL_MIN_INTERVAL_SECONDS = 15.0
DISCOVERY_TTL_SECONDS = 10.0
# After a window resets the record is re-read early, but never more often than
# this: a provider (or a skewed clock) can keep reporting a reset time that has
# already passed, and every client poll must not turn into a probe.
EARLY_REREAD_MIN_SECONDS = 60.0
FAILURE_BACKOFF_BASE_SECONDS = 60.0
FAILURE_BACKOFF_MAX_SECONDS = 1800.0
RATE_LIMIT_DEFAULT_SECONDS = 300.0
RATE_LIMIT_MAX_SECONDS = 3600.0
SOURCE_RANK = {"env": 0, "default": 1, "switcher": 2, "accounts-dir": 3, "config": 4}


@dataclass
class _Account:
    key: str
    adapter: UsageAdapter
    home: ProviderHome
    identity: AccountIdentity
    homes: list[ProviderHome]
    email: str | None
    display_name: str | None
    organization: str | None


@dataclass
class _Entry:
    windows: list[UsageWindow] = field(default_factory=list)
    plan: str | None = None
    email: str | None = None
    fetched_at: float | None = None
    checked_at: float | None = None
    error_kind: str | None = None
    message: str | None = None
    failures: int = 0
    # Backoff gate after a failure; zero while the last probe succeeded.
    next_attempt_at: float = 0.0
    # An auth rejection holds until the CLI rewrites its credentials.
    blocked_fingerprint: str | None = None


class UsageService:
    def __init__(
        self,
        adapters: Sequence[UsageAdapter],
        *,
        refresh_interval_seconds: float | None = None,
        manual_min_interval_seconds: float = MANUAL_MIN_INTERVAL_SECONDS,
        discovery_ttl_seconds: float = DISCOVERY_TTL_SECONDS,
        clock: Callable[[], float] = time.time,
        max_workers: int = 3,
    ) -> None:
        self._adapters = list(adapters)
        self._interval = refresh_interval_seconds or _interval_from_env()
        self._stale_after = self._interval * 2 + 60
        self._manual_min_interval = manual_min_interval_seconds
        self._discovery_ttl = discovery_ttl_seconds
        self._clock = clock
        self._lock = threading.RLock()
        self._entries: dict[str, _Entry] = {}
        self._inflight: dict[str, Future[None]] = {}
        self._discovered: tuple[float, list[_Account]] | None = None
        # Last identity that parsed, per home, to ride out a file caught mid-rewrite.
        self._last_identity: dict[tuple[str, Path], AccountIdentity] = {}
        # Homes whose probe was discarded because their account changed mid-flight.
        self._home_holds: dict[tuple[str, Path], float] = {}
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="athena-usage")
        self._closed = False

    @property
    def refresh_interval_seconds(self) -> float:
        return self._interval

    # ------------------------------------------------------------ public API

    def snapshot(self, *, schedule: bool = True) -> dict[str, Any]:
        """Cached records for every discovered account; never waits on a provider."""
        accounts = self._accounts()
        if schedule:
            now = self._clock()
            for account in accounts:
                if self._due(account, now):
                    self._start(account)
        return self._payload(accounts)

    def refresh(
        self,
        *,
        provider: str | None = None,
        account_key: str | None = None,
        wait_seconds: float = 12.0,
    ) -> dict[str, Any]:
        """Force a probe of the matching accounts, waiting a bounded time for it.

        Raises ``KeyError`` when ``account_key`` names no current account.
        """
        accounts = self._accounts(force=True)
        targets = [
            account
            for account in accounts
            if (provider is None or account.adapter.provider == provider)
            and (account_key is None or account.key == account_key)
        ]
        if account_key is not None and not targets:
            raise KeyError(account_key)
        futures = [future for account in targets if (future := self._start(account, manual=True)) is not None]
        deadline = time.monotonic() + wait_seconds
        # Short slices so a backend shutdown is not held up by a slow provider.
        while futures and not self._closed:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            _, pending = wait(futures, timeout=min(remaining, 0.25))
            futures = list(pending)
        return self._payload(self._accounts())

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)
        for adapter in self._adapters:
            close = getattr(adapter, "close", None)
            if callable(close):
                close()

    # ------------------------------------------------------------- discovery

    def _accounts(self, *, force: bool = False) -> list[_Account]:
        now = self._clock()
        with self._lock:
            if not force and self._discovered and now - self._discovered[0] < self._discovery_ttl:
                return self._discovered[1]

        accounts = self._discover()
        with self._lock:
            self._discovered = (now, accounts)
            live = {account.key for account in accounts}
            # An account no longer signed in anywhere takes its cached windows
            # with it; if it comes back it starts over from a fresh probe.
            for key in list(self._entries):
                if key not in live and key not in self._inflight:
                    del self._entries[key]
        return accounts

    def _discover(self) -> list[_Account]:
        grouped: dict[str, list[tuple[UsageAdapter, ProviderHome, AccountIdentity]]] = {}
        for adapter in self._adapters:
            try:
                homes = adapter.discover_homes()
            except Exception:
                continue
            for home in homes:
                try:
                    identity = self._stable_identity(adapter, home, adapter.read_identity(home))
                except Exception:
                    continue
                grouped.setdefault(identity.account_key(home), []).append((adapter, home, identity))

        accounts: list[_Account] = []
        for key, members in grouped.items():
            members.sort(key=_probe_preference)
            adapter, home, identity = members[0]
            identities = [member[2] for member in members]
            accounts.append(
                _Account(
                    key=key,
                    adapter=adapter,
                    home=home,
                    identity=identity,
                    homes=[member[1] for member in members],
                    email=_first(item.email for item in identities),
                    display_name=_first(item.display_name for item in identities),
                    organization=_first(item.organization for item in identities),
                )
            )
        provider_order = {adapter.provider: index for index, adapter in enumerate(self._adapters)}
        accounts.sort(
            key=lambda account: (
                provider_order.get(account.adapter.provider, 99),
                SOURCE_RANK.get(account.home.source, 9),
                account.home.label,
            )
        )
        return accounts

    def _stable_identity(self, adapter: UsageAdapter, home: ProviderHome, identity: AccountIdentity) -> AccountIdentity:
        slot = (adapter.provider, home.path)
        with self._lock:
            if identity.unreadable:
                return self._last_identity.get(slot, identity)
            self._last_identity[slot] = identity
        return identity

    # ------------------------------------------------------------ scheduling

    def _due(self, account: _Account, now: float) -> bool:
        if account.identity.credential_state != "ok":
            return False
        with self._lock:
            if account.key in self._inflight or self._held(account, now):
                return False
            entry = self._entries.get(account.key)
            if entry is None:
                return True
            if entry.blocked_fingerprint is not None:
                # A rejected login is only retried once the CLI rewrites it.
                return entry.blocked_fingerprint != account.identity.credential_fingerprint
            if now < entry.next_attempt_at:
                return False
            if entry.fetched_at is None or now - entry.fetched_at >= self._interval:
                return True
            # A window that has reset no longer describes the account; re-read early.
            if entry.checked_at is not None and now - entry.checked_at < EARLY_REREAD_MIN_SECONDS:
                return False
            current = _utc(now)
            return any(not window.is_open(current) for window in entry.windows)

    def _start(self, account: _Account, *, manual: bool = False) -> Future[None] | None:
        if account.identity.credential_state != "ok":
            return None
        now = self._clock()
        with self._lock:
            if self._closed:
                return None
            existing = self._inflight.get(account.key)
            if existing is not None:
                return existing
            if self._held(account, now):
                return None
            entry = self._entries.get(account.key)
            if manual and entry is not None:
                if entry.checked_at is not None and now - entry.checked_at < self._manual_min_interval:
                    return None
                if entry.error_kind == "rate_limited" and now < entry.next_attempt_at:
                    return None  # the provider asked us to wait; a button press does not change that
            future = self._executor.submit(self._probe, account)
            self._inflight[account.key] = future
            return future

    def _probe(self, account: _Account) -> None:
        try:
            result = account.adapter.probe(account.home, account.identity)
        except Exception as error:  # adapters should not raise; never let one poison the cache
            result = ProbeResult.failure("unavailable", f"Usage probe failed ({type(error).__name__}).")

        # The home may have signed into another account while the probe ran;
        # then the answer could belong to either, so it is thrown away.
        try:
            after = self._stable_identity(account.adapter, account.home, account.adapter.read_identity(account.home))
            account_changed = after.account_key(account.home) != account.key
        except Exception:
            account_changed = True

        now = self._clock()
        with self._lock:
            self._inflight.pop(account.key, None)
            if account_changed:
                self._discovered = None
                # Hold the home briefly so a login that keeps flipping cannot
                # turn every poll into a probe.
                self._home_holds[(account.adapter.provider, account.home.path)] = now + EARLY_REREAD_MIN_SECONDS
                return
            if self._discovered is not None and account.key not in {item.key for item in self._discovered[1]}:
                return  # the account was signed out everywhere while probing
            entry = self._entries.setdefault(account.key, _Entry())
            entry.checked_at = now
            if result.ok:
                # A window reported with a reset time already behind us is over.
                current = _utc(now)
                entry.windows = [window for window in result.windows if window.is_open(current)]
                entry.plan = result.plan or entry.plan
                entry.email = result.email or entry.email
                entry.fetched_at = now
                entry.error_kind = None
                entry.message = None
                entry.failures = 0
                entry.blocked_fingerprint = None
                entry.next_attempt_at = 0.0
                return

            entry.failures += 1
            entry.error_kind = result.error_kind or "unavailable"
            entry.message = result.message
            if result.error_kind == "rate_limited":
                delay = min(max(result.retry_after_seconds or RATE_LIMIT_DEFAULT_SECONDS, 60.0), RATE_LIMIT_MAX_SECONDS)
            elif result.error_kind in ("auth", "expired"):
                entry.blocked_fingerprint = account.identity.credential_fingerprint
                delay = 0.0
            else:
                delay = min(FAILURE_BACKOFF_BASE_SECONDS * 2 ** (entry.failures - 1), FAILURE_BACKOFF_MAX_SECONDS)
            entry.next_attempt_at = now + delay

    # --------------------------------------------------------------- payload

    def _payload(self, accounts: Iterable[_Account]) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            records = [self._record(account, self._entries.get(account.key), now) for account in accounts]
        return {
            "accounts": records,
            "generated_at": iso(_utc(now)),
            "refresh_interval_seconds": int(self._interval),
        }

    def _record(self, account: _Account, entry: _Entry | None, now: float) -> dict[str, Any]:
        identity = account.identity
        current = _utc(now)
        # Windows whose reset time has passed describe a period that is over.
        windows = [window for window in (entry.windows if entry else []) if window.is_open(current)]
        fresh = bool(
            entry
            and entry.fetched_at is not None
            and entry.error_kind is None
            and now - entry.fetched_at <= self._stale_after
        )
        refreshing = account.key in self._inflight
        hint = account.adapter.signed_out_hint(account.home)
        state = identity.credential_state

        if state == "missing":
            status, message = "signed_out", f"Not signed in. {hint}"
        elif state == "unsupported":
            status, message = "unsupported", _unsupported_message(account.adapter.provider, hint)
        elif state == "expired" or (entry and entry.error_kind == "expired"):
            status, message = "expired", account.adapter.expired_hint(account.home)
        elif entry and entry.error_kind == "auth":
            status = "expired"
            message = f"{account.adapter.display_name} rejected the saved sign-in. {hint}"
        elif entry is None or (entry.fetched_at is None and entry.error_kind is None):
            status, message = "loading", None
        elif entry.error_kind is not None and not windows:
            status = "rate_limited" if entry.error_kind == "rate_limited" else "error"
            message = entry.message
        elif not fresh:
            status = "stale"
            message = entry.message or "Usage has not been refreshed recently."
        else:
            status, message = "ok", None

        # Logins Athena will not probe get no promise of a next check.
        next_refresh = self._next_refresh(entry, windows, now) if state == "ok" else None
        return {
            "key": account.key,
            "provider": account.adapter.provider,
            "provider_name": account.adapter.display_name,
            "account": {
                "email": account.email or (entry.email if entry else None),
                "display_name": account.display_name,
                "organization": account.organization,
                "identified": identity.stable_id is not None,
            },
            "profiles": [{"label": home.label, "path": home.display_path()} for home in account.homes],
            "plan": (entry.plan if entry and entry.plan else None) or identity.plan,
            "status": status,
            "message": message,
            "windows": [window.payload() for window in windows],
            # Only a fresh reading on a working login counts as live.
            "stale": bool(windows) and (not fresh or status != "ok"),
            "refreshing": refreshing,
            "fetched_at": iso(_utc(entry.fetched_at)) if entry and entry.fetched_at else None,
            "checked_at": iso(_utc(entry.checked_at)) if entry and entry.checked_at else None,
            "next_refresh_at": iso(_utc(next_refresh)) if next_refresh else None,
        }


    def _held(self, account: _Account, now: float) -> bool:
        return self._home_holds.get((account.adapter.provider, account.home.path), 0.0) > now

    def _next_refresh(self, entry: _Entry | None, windows: list[UsageWindow], now: float) -> float | None:
        if entry is None or entry.blocked_fingerprint is not None:
            return None
        if entry.next_attempt_at > now:
            return entry.next_attempt_at
        if entry.fetched_at is None:
            return None
        due = entry.fetched_at + self._interval
        resets = [window.resets_at.timestamp() for window in windows if window.resets_at is not None]
        return min([due, *resets])


def create_default_usage_service(*, codex_executable: str | None = None) -> UsageService:
    from .claude import ClaudeUsageAdapter
    from .codex import CodexUsageAdapter

    return UsageService([ClaudeUsageAdapter(), CodexUsageAdapter(executable=codex_executable)])


def _probe_preference(member: tuple[UsageAdapter, ProviderHome, AccountIdentity]) -> tuple[Any, ...]:
    _, home, identity = member
    # Prefer a working login, then the one that stays probe-able longest.
    expires = identity.expires_at.timestamp() if identity.expires_at else 0.0
    return (identity.credential_state != "ok", -expires, SOURCE_RANK.get(home.source, 9), home.label)


def _unsupported_message(provider: str, hint: str) -> str:
    if provider == "codex":
        return "This Codex home uses an API key, which has no subscription quota to show."
    return hint


def _interval_from_env() -> float:
    try:
        value = float(os.environ.get(REFRESH_INTERVAL_ENV, "") or DEFAULT_REFRESH_INTERVAL_SECONDS)
    except ValueError:
        value = DEFAULT_REFRESH_INTERVAL_SECONDS
    return max(value, MIN_REFRESH_INTERVAL_SECONDS)


def _first(values: Iterable[str | None]) -> str | None:
    return next((value for value in values if value), None)


def _utc(timestamp: float) -> datetime:
    return datetime.fromtimestamp(timestamp, timezone.utc)
