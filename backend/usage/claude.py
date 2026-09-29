"""Claude subscription usage from Claude Code's own OAuth login.

Claude Code keeps its login in ``<config dir>/.credentials.json`` (Linux) and
the account profile in ``.claude.json``. The CLI owns token refresh; this
adapter only reads the saved access token and asks Anthropic's usage endpoint
for the current windows. An expired token is reported, not refreshed.

The endpoint reports ``utilization`` as a 0..100 percentage (Claude Code's own
``/usage`` view prints ``Math.floor(utilization)% used``), with ``null`` for a
window that does not apply. Model-scoped allowances only appear in the
``limits`` array.

The record is keyed by the account in ``.claude.json``, but the windows come
from whatever token ``.credentials.json`` holds, and a login or credential swap
rewrites the two files at different moments. So before a token's windows are
trusted, ``/api/oauth/profile`` confirms which account the token belongs to.
That check runs once per credential-file version, not on every probe.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable

from .base import (
    AccountIdentity,
    ProbeResult,
    ProviderHome,
    UsageWindow,
    content_fingerprint,
    env_paths,
    json_object,
    parse_percent,
    parse_timestamp,
    read_bytes,
    resolved,
)

USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"
REQUEST_TIMEOUT_SECONDS = 10.0
EXTRA_HOMES_ENV = "CONTEXT_WORKSPACE_USAGE_CLAUDE_HOMES"
SWITCHER_PROFILES = Path("~/.config/claude-account-switcher/profiles.json")
ACCOUNTS_ROOT = Path("~/.claude-accounts")

# Flat buckets, in display order. ``seven_day_oauth_apps`` and the codenamed
# buckets are not what Claude Code's /usage shows, so they are left out.
FLAT_BUCKETS: tuple[tuple[str, str, str, int], ...] = (
    ("five_hour", "session", "Session", 300),
    ("seven_day", "weekly", "Weekly", 10080),
    ("seven_day_opus", "weekly:opus", "Weekly · Opus", 10080),
    ("seven_day_sonnet", "weekly:sonnet", "Weekly · Sonnet", 10080),
)
UNSCOPED_LIMIT_KINDS = {"session": "session", "weekly_all": "weekly"}

HttpGet = Callable[[str, dict[str, str], float], tuple[int, dict[str, str], bytes]]


class ClaudeUsageAdapter:
    provider = "claude"
    display_name = "Claude"

    def __init__(
        self,
        *,
        home_dir: Path | None = None,
        env: dict[str, str] | None = None,
        http_get: HttpGet | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._home_dir = home_dir
        self._env = env
        self._http_get = http_get or _urllib_get
        self._clock = clock
        # home path -> (credential fingerprint, account id the profile endpoint confirmed)
        self._verified: dict[Path, tuple[str, str]] = {}
        self._verified_lock = threading.Lock()

    # ------------------------------------------------------------- discovery

    def discover_homes(self) -> list[ProviderHome]:
        home_dir = self._home_dir or Path.home()
        env = self._env if self._env is not None else dict(os.environ)
        candidates: list[tuple[Path, str, str]] = []

        configured = env.get("CLAUDE_CONFIG_DIR", "").strip()
        default_dir = home_dir / ".claude"
        if configured:
            candidates.append((Path(configured).expanduser(), Path(configured).name or "env", "env"))
        candidates.append((default_dir, "default", "default"))

        # Profiles registered with claude-account-switcher (`cas`), by name.
        profiles = _read_json(_expand(SWITCHER_PROFILES, home_dir))
        for name, profile in (profiles.get("profiles") or {}).items() if isinstance(profiles, dict) else ():
            if isinstance(profile, dict) and isinstance(profile.get("config_dir"), str):
                candidates.append((Path(profile["config_dir"]).expanduser(), str(name), "switcher"))

        accounts_root = _expand(ACCOUNTS_ROOT, home_dir)
        if accounts_root.is_dir():
            for child in sorted(accounts_root.iterdir()):
                if child.is_dir():
                    candidates.append((child, child.name, "accounts-dir"))

        for path in env_paths(env, EXTRA_HOMES_ENV):
            candidates.append((path, path.name, "config"))

        homes: dict[Path, ProviderHome] = {}
        for path, label, source in candidates:
            real = resolved(path)
            if real in homes:
                continue
            if not (real / ".credentials.json").is_file() and not self._has_metadata(real, home_dir):
                continue
            homes[real] = ProviderHome(provider=self.provider, path=real, label=label, source=source)
        return list(homes.values())

    def _has_metadata(self, path: Path, home_dir: Path) -> bool:
        return path.is_dir() and self._metadata_path(path, home_dir).is_file()

    @staticmethod
    def _metadata_path(path: Path, home_dir: Path) -> Path:
        # Without CLAUDE_CONFIG_DIR, Claude Code keeps the profile in ~/.claude.json
        # beside ~/.claude; a redirected profile keeps it inside its own dir.
        if path == resolved(home_dir / ".claude"):
            return home_dir / ".claude.json"
        return path / ".claude.json"

    # -------------------------------------------------------------- identity

    def read_identity(self, home: ProviderHome) -> AccountIdentity:
        home_dir = self._home_dir or Path.home()
        credentials_path = home.path / ".credentials.json"
        metadata_path = self._metadata_path(home.path, home_dir)
        raw = read_bytes(credentials_path)
        login = _oauth_login(raw)
        account = _read_json(metadata_path).get("oauthAccount") if metadata_path.is_file() else None
        account = account if isinstance(account, dict) else {}

        account_uuid = _text(account.get("accountUuid"))
        organization_uuid = _text(account.get("organizationUuid"))
        stable_id = f"{organization_uuid or '-'}:{account_uuid}" if account_uuid else None

        expires_at = parse_timestamp(login.get("expiresAt")) if login else None
        if not login and sys.platform == "darwin" and raw is None:
            state = "unsupported"
        elif not login or not _text(login.get("accessToken")):
            state = "missing"
        elif expires_at is not None and expires_at.timestamp() <= self._clock():
            state = "expired"
        else:
            state = "ok"

        return AccountIdentity(
            provider=self.provider,
            stable_id=stable_id,
            email=_text(account.get("emailAddress")),
            display_name=_text(account.get("displayName")) or _text(account.get("fullName")),
            organization=_text(account.get("organizationName")),
            plan=plan_label(_text(login.get("rateLimitTier")), _text(login.get("subscriptionType"))) if login else None,
            credential_state=state,
            credential_fingerprint=content_fingerprint(raw),
            expires_at=expires_at,
        )

    def signed_out_hint(self, home: ProviderHome) -> str:
        if sys.platform == "darwin":
            return "Claude Code on macOS keeps its login in the Keychain, which usage monitoring does not read."
        if home.source == "default":
            return "Run `claude` (or `claude auth login`) to sign in."
        return f"Run Claude Code with CLAUDE_CONFIG_DIR={home.display_path()} to sign in."

    def expired_hint(self, home: ProviderHome) -> str:
        where = "" if home.source == "default" else f" with CLAUDE_CONFIG_DIR={home.display_path()}"
        return (
            f"The saved access token has expired. Claude Code refreshes it the next time it runs{where}; "
            "Athena does not refresh logins itself."
        )

    # ----------------------------------------------------------------- probe

    def probe(self, home: ProviderHome, identity: AccountIdentity) -> ProbeResult:
        raw = read_bytes(home.path / ".credentials.json")
        login = _oauth_login(raw)
        token = _text(login.get("accessToken")) if login else None
        if not token:
            return ProbeResult.failure("auth", "Not signed in to Claude Code.")
        expires_at = parse_timestamp(login.get("expiresAt"))
        if expires_at is not None and expires_at.timestamp() <= self._clock():
            return ProbeResult.failure("expired", "Claude Code's saved sign-in expired.")

        mismatch = self._verify_account(home, identity, token, content_fingerprint(raw))
        if mismatch is not None:
            return mismatch

        _, _, body, failure = self._get(USAGE_ENDPOINT, token, "usage")
        if failure is not None:
            return failure
        try:
            payload = json.loads(body.decode("utf-8", errors="replace"))
        except ValueError:
            return ProbeResult.failure("protocol", "Anthropic's usage endpoint returned invalid JSON.")
        if not isinstance(payload, dict):
            return ProbeResult.failure("protocol", "Anthropic's usage endpoint returned an unexpected payload.")

        windows = parse_usage_payload(payload)
        if not windows:
            return ProbeResult.failure("unavailable", "Anthropic reported no quota windows for this account.")
        return ProbeResult(ok=True, windows=windows, plan=identity.plan)

    def _verify_account(self, home: ProviderHome, identity: AccountIdentity, token: str, fingerprint: str) -> ProbeResult | None:
        """Confirm the token belongs to the account the record is keyed by."""
        if identity.stable_id is None:
            return None  # an unidentified home is keyed by its path; nothing to cross-check
        with self._verified_lock:
            if self._verified.get(home.path) == (fingerprint, identity.stable_id):
                return None
        _, _, body, failure = self._get(PROFILE_ENDPOINT, token, "profile")
        if failure is not None:
            return failure
        profile = json_object(body)
        account = profile.get("account") if isinstance(profile.get("account"), dict) else {}
        organization = profile.get("organization") if isinstance(profile.get("organization"), dict) else {}
        account_uuid = _text(account.get("uuid"))
        if not account_uuid:
            return ProbeResult.failure("protocol", "Anthropic's profile endpoint did not name the token's account.")
        token_account = f"{_text(organization.get('uuid')) or '-'}:{account_uuid}"
        if token_account != identity.stable_id:
            return ProbeResult.failure(
                "protocol",
                "The saved token belongs to a different account than this profile's metadata "
                "(a sign-in may be in progress). Retrying shortly.",
            )
        with self._verified_lock:
            self._verified[home.path] = (fingerprint, identity.stable_id)
        return None

    def _get(self, url: str, token: str, what: str) -> tuple[int, dict[str, str], bytes, ProbeResult | None]:
        headers = {
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "Accept": "application/json",
            "User-Agent": "athena-usage/1",
        }
        try:
            status, response_headers, body = self._http_get(url, headers, REQUEST_TIMEOUT_SECONDS)
        except TimeoutError:
            return 0, {}, b"", ProbeResult.failure("timeout", f"Anthropic's {what} endpoint did not answer in time.")
        except OSError:
            return 0, {}, b"", ProbeResult.failure("network", f"Couldn't reach Anthropic's {what} endpoint.")
        if status in (401, 403):
            return status, response_headers, body, ProbeResult.failure("auth", "Anthropic rejected the saved Claude Code sign-in.")
        if status == 429:
            retry_after = _retry_after_seconds(response_headers.get("retry-after"))
            return status, response_headers, body, ProbeResult.failure(
                "rate_limited", "Anthropic is rate limiting usage checks.", retry_after_seconds=retry_after
            )
        if status < 200 or status >= 300:
            return status, response_headers, body, ProbeResult.failure(
                "unavailable", f"Anthropic's {what} endpoint returned HTTP {status}."
            )
        return status, response_headers, body, None


def parse_usage_payload(payload: dict[str, Any]) -> list[UsageWindow]:
    windows: dict[str, UsageWindow] = {}

    for key, window_id, label, minutes in FLAT_BUCKETS:
        bucket = payload.get(key)
        if not isinstance(bucket, dict):
            continue
        percent = parse_percent(bucket.get("utilization"))
        if percent is None:
            continue
        windows[window_id] = UsageWindow(window_id, label, percent, parse_timestamp(bucket.get("resets_at")), minutes)

    entries = payload.get("limits")
    for entry in entries if isinstance(entries, list) else ():
        if not isinstance(entry, dict):
            continue
        percent = parse_percent(entry.get("percent"))
        if percent is None:
            continue
        kind = _text(entry.get("kind")) or ""
        resets_at = parse_timestamp(entry.get("resets_at"))
        scope = entry.get("scope")
        model = scope.get("model") if isinstance(scope, dict) else None
        if isinstance(model, dict):
            name = _text(model.get("display_name")) or _text(model.get("id"))
            if not name:
                continue
            period, minutes = _scoped_period(kind, _text(entry.get("group")))
            window_id = f"{'session' if minutes == 300 else 'weekly' if minutes == 10080 else kind or 'limit'}:{_slug(name)}"
            label = f"{period} · {name}"
        elif kind in UNSCOPED_LIMIT_KINDS:
            # The flat bucket is authoritative when present; the array only
            # fills in when an account's payload has no flat bucket.
            window_id = UNSCOPED_LIMIT_KINDS[kind]
            label, minutes = ("Session", 300) if window_id == "session" else ("Weekly", 10080)
        else:
            continue
        windows.setdefault(window_id, UsageWindow(window_id, label, percent, resets_at, minutes))

    return list(windows.values())


def plan_label(tier: str | None, subscription: str | None) -> str | None:
    match = re.search(r"max_(\d+x)", tier or "", re.IGNORECASE)
    if match:
        return f"Max {match.group(1).lower()}"
    if subscription:
        return subscription[:1].upper() + subscription[1:]
    return None


def _scoped_period(kind: str, group: str | None) -> tuple[str, int | None]:
    text = f"{kind} {group or ''}".lower()
    if "month" in text:
        return "Monthly", None
    if "week" in text or "seven_day" in text:
        return "Weekly", 10080
    if "hour" in text or "session" in text:
        return "Session", 300
    return "Limit", None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "model"


def _oauth_login(raw: bytes | None) -> dict[str, Any]:
    login = json_object(raw).get("claudeAiOauth")
    return login if isinstance(login, dict) else {}


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        return max(0.0, parsed.timestamp() - time.time())
    return seconds if seconds >= 0 else None


def _expand(path: Path, home_dir: Path) -> Path:
    text = str(path)
    return home_dir / text[2:] if text.startswith("~/") else path


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    # A redirect would carry the bearer token to wherever it points; treat any
    # 3xx as a failed check instead of following it.
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


_OPENER = urllib.request.build_opener(_NoRedirects)


def _urllib_get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, method="GET")
    for name, value in headers.items():
        request.add_unredirected_header(name, value)
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read(1_000_000)
    except urllib.error.HTTPError as error:
        response_headers = {k.lower(): v for k, v in (error.headers or {}).items()}
        return error.code, response_headers, b""
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise TimeoutError(str(error.reason)) from error
        raise OSError(str(error.reason)) from error
