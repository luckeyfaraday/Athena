"""Codex subscription usage from the Codex CLI's own app-server.

Each probe starts a short-lived ``codex app-server`` against one ``CODEX_HOME``
and speaks its JSON-RPC over stdio: ``initialize``, ``initialized``, then
``account/rateLimits/read``. ``account/read`` is only a bounded fallback for
the plan, because some Codex releases leave it unanswered and it must never
cost the limits already in hand. The CLI owns the login and any token refresh.

Identity comes from the ``id_token`` claims in ``auth.json`` (decoded, not
verified: it only labels and keys the record; the token itself stays here),
and the ``accountId`` the app-server reports is checked against it.

Starting the app-server makes Codex refresh a login that has gone stale, and a
refresh rotates the refresh token in ``auth.json``. A monitor must not do that
to a home nobody is using (or race a session that is), so a home is only
probed while its login is fresh: an unexpired access token, refreshed within
the last week. Codex's own sessions keep an active home fresh.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Protocol

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
    window_label,
)

EXTRA_HOMES_ENV = "CONTEXT_WORKSPACE_USAGE_CODEX_HOMES"
ACCOUNTS_ROOT_NAME = ".codex-accounts"
INITIALIZE_TIMEOUT_SECONDS = 10.0
RATE_LIMITS_TIMEOUT_SECONDS = 12.0
ACCOUNT_READ_TIMEOUT_SECONDS = 3.0
AUTH_CLAIMS = "https://api.openai.com/auth"
CLIENT_INFO = {"name": "athena-usage", "title": "Athena usage monitor", "version": "1"}
# Codex refreshes a login on use once it is about 8 days old (access tokens last
# 10). Stop probing a day earlier so the monitor never triggers that refresh.
FRESH_LOGIN_SECONDS = 7 * 24 * 3600
ACCESS_TOKEN_MARGIN_SECONDS = 3600


class RpcSession(Protocol):
    def request(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]: ...

    def notify(self, method: str, params: dict[str, Any]) -> None: ...

    def close(self) -> None: ...


SessionFactory = Callable[[ProviderHome], RpcSession]


class RpcError(Exception):
    def __init__(self, message: str, *, timeout: bool = False) -> None:
        super().__init__(message)
        self.timeout = timeout


class CodexUsageAdapter:
    provider = "codex"
    display_name = "Codex"

    def __init__(
        self,
        *,
        home_dir: Path | None = None,
        env: dict[str, str] | None = None,
        session_factory: SessionFactory | None = None,
        executable: str | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._home_dir = home_dir
        self._env = env
        self._session_factory = session_factory or self._spawn_session
        self._executable = executable
        self._clock = clock
        self._sessions: set[RpcSession] = set()
        self._sessions_lock = threading.Lock()
        self._closed = False

    # ------------------------------------------------------------- discovery

    def discover_homes(self) -> list[ProviderHome]:
        home_dir = self._home_dir or Path.home()
        env = self._env if self._env is not None else dict(os.environ)
        candidates: list[tuple[Path, str, str]] = []

        configured = env.get("CODEX_HOME", "").strip()
        if configured:
            candidates.append((Path(configured).expanduser(), Path(configured).name or "env", "env"))
        candidates.append((home_dir / ".codex", "default", "default"))

        accounts_root = home_dir / ACCOUNTS_ROOT_NAME
        if accounts_root.is_dir():
            for child in sorted(accounts_root.iterdir()):
                if child.is_dir():
                    candidates.append((child, child.name, "accounts-dir"))

        for path in env_paths(env, EXTRA_HOMES_ENV):
            candidates.append((path, path.name, "config"))

        homes: dict[Path, ProviderHome] = {}
        for path, label, source in candidates:
            real = resolved(path)
            if real in homes or not (real / "auth.json").is_file():
                continue
            homes[real] = ProviderHome(provider=self.provider, path=real, label=label, source=source)
        return list(homes.values())

    # -------------------------------------------------------------- identity

    def read_identity(self, home: ProviderHome) -> AccountIdentity:
        raw = read_bytes(home.path / "auth.json")
        auth = json_object(raw)
        tokens = auth.get("tokens") if isinstance(auth.get("tokens"), dict) else {}
        claims = decode_jwt_claims(tokens.get("id_token"))
        openai = claims.get(AUTH_CLAIMS) if isinstance(claims.get(AUTH_CLAIMS), dict) else {}

        user_id = _text(openai.get("chatgpt_user_id")) or _text(openai.get("user_id")) or _text(claims.get("sub"))
        account_id = _text(openai.get("chatgpt_account_id")) or _text(tokens.get("account_id"))
        stable_id = f"{user_id or '-'}:{account_id}" if account_id else (f"{user_id}:-" if user_id else None)

        has_chatgpt_login = bool(_text(tokens.get("refresh_token")) or _text(tokens.get("access_token")))
        api_key_only = not has_chatgpt_login and bool(_text(auth.get("OPENAI_API_KEY")))
        fresh_until = self._fresh_until(tokens, auth)
        if not has_chatgpt_login:
            state = "unsupported" if api_key_only else "missing"
        elif fresh_until is not None and fresh_until.timestamp() <= self._clock():
            state = "expired"
        else:
            state = "ok"

        return AccountIdentity(
            provider=self.provider,
            stable_id=stable_id,
            email=_text(claims.get("email")),
            display_name=_text(claims.get("name")),
            organization=None,
            plan=plan_label(_text(openai.get("chatgpt_plan_type"))),
            credential_state=state,
            credential_fingerprint=content_fingerprint(raw),
            expires_at=fresh_until,
        )

    @staticmethod
    def _fresh_until(tokens: dict[str, Any], auth: dict[str, Any]) -> datetime | None:
        """When probing would start forcing Codex to refresh this login."""
        limits: list[datetime] = []
        access_expiry = parse_timestamp(decode_jwt_claims(tokens.get("access_token")).get("exp"))
        if access_expiry is not None:
            limits.append(access_expiry - timedelta(seconds=ACCESS_TOKEN_MARGIN_SECONDS))
        last_refresh = parse_timestamp(auth.get("last_refresh"))
        if last_refresh is not None:
            limits.append(last_refresh + timedelta(seconds=FRESH_LOGIN_SECONDS))
        return min(limits) if limits else None

    def signed_out_hint(self, home: ProviderHome) -> str:
        if home.source == "default":
            return "Run `codex login` to sign in with ChatGPT."
        return f"Run `CODEX_HOME={home.display_path()} codex login` to sign in with ChatGPT."

    def expired_hint(self, home: ProviderHome) -> str:
        where = "" if home.source == "default" else f" with CODEX_HOME={home.display_path()}"
        return (
            f"This login has not been refreshed recently. Codex refreshes it the next time it runs{where}; "
            "Athena won't, because refreshing rotates the saved credentials."
        )

    # ----------------------------------------------------------------- probe

    def probe(self, home: ProviderHome, identity: AccountIdentity) -> ProbeResult:
        try:
            session = self._session_factory(home)
        except FileNotFoundError:
            return ProbeResult.failure("unavailable", "The codex CLI was not found on PATH.")
        except OSError as error:
            return ProbeResult.failure("unavailable", f"Couldn't start codex app-server: {error}")

        with self._sessions_lock:
            closed = self._closed
            if not closed:
                self._sessions.add(session)
        if closed:
            session.close()
            return ProbeResult.failure("unavailable", "Athena is shutting down.")
        try:
            try:
                session.request("initialize", {"clientInfo": CLIENT_INFO}, INITIALIZE_TIMEOUT_SECONDS)
                session.notify("initialized", {})
                response = session.request(
                    "account/rateLimits/read",
                    {"excludeResetCreditDetails": True},
                    RATE_LIMITS_TIMEOUT_SECONDS,
                )
            except RpcError as error:
                return _rpc_failure(error)

            reported = _text(response.get("accountId"))
            expected = _account_part(identity.stable_id)
            if reported and expected and reported != expected:
                return ProbeResult.failure(
                    "protocol",
                    "Codex answered for a different account than this profile's login "
                    "(a sign-in may be in progress). Retrying shortly.",
                )
            windows, plan = parse_rate_limits(response)
            email = None
            if not plan:
                try:
                    account = session.request("account/read", {}, ACCOUNT_READ_TIMEOUT_SECONDS).get("account")
                except RpcError:
                    account = None
                if isinstance(account, dict):
                    plan = plan_label(_text(account.get("planType")))
                    email = _text(account.get("email"))
        finally:
            with self._sessions_lock:
                self._sessions.discard(session)
            session.close()

        if not windows:
            return ProbeResult.failure("unavailable", "Codex reported no rate-limit windows for this account.")
        return ProbeResult(ok=True, windows=windows, plan=plan or identity.plan, email=email)

    def close(self) -> None:
        """Reap any app-server still running, e.g. when the backend shuts down."""
        with self._sessions_lock:
            self._closed = True
            sessions = list(self._sessions)
            self._sessions.clear()
        for session in sessions:
            session.close()

    def _spawn_session(self, home: ProviderHome) -> RpcSession:
        # The backend runs with the PATH Athena's terminals use, so this finds
        # the same codex the user's panes launch (or an explicit override).
        executable = shutil.which(self._executable or "codex")
        if not executable:
            raise FileNotFoundError("codex")
        env = dict(self._env if self._env is not None else os.environ)
        env["CODEX_HOME"] = str(home.path)
        return AppServerSession([executable, "app-server"], env=env)


def parse_rate_limits(response: dict[str, Any]) -> tuple[list[UsageWindow], str | None]:
    """Windows from an ``account/rateLimits/read`` result.

    ``rateLimitsByLimitId`` is the multi-bucket view (the ``codex`` bucket plus
    any model-scoped ones); ``rateLimits`` is its single-bucket mirror, used
    only when the multi-bucket view is absent.
    """
    buckets: list[tuple[str, dict[str, Any]]] = []
    by_id = response.get("rateLimitsByLimitId")
    if isinstance(by_id, dict) and by_id:
        # The main ``codex`` bucket first, the rest in a stable order.
        for limit_id in sorted(by_id, key=lambda key: (key != "codex", key)):
            if isinstance(by_id[limit_id], dict):
                buckets.append((str(limit_id), by_id[limit_id]))
    elif isinstance(response.get("rateLimits"), dict):
        snapshot = response["rateLimits"]
        buckets.append((_text(snapshot.get("limitId")) or "codex", snapshot))

    windows: list[UsageWindow] = []
    plan: str | None = None
    for limit_id, snapshot in buckets:
        plan = plan or plan_label(_text(snapshot.get("planType")))
        scope = _text(snapshot.get("limitName")) or (None if limit_id == "codex" else limit_id)
        for slot in ("primary", "secondary"):
            window = snapshot.get(slot)
            if not isinstance(window, dict):
                continue
            percent = parse_percent(window.get("usedPercent"))
            if percent is None:
                continue
            minutes = window.get("windowDurationMins")
            minutes = int(minutes) if isinstance(minutes, int) and not isinstance(minutes, bool) and minutes > 0 else None
            label = window_label(minutes)
            windows.append(
                UsageWindow(
                    id=f"{limit_id}:{minutes or slot}",
                    label=f"{label} · {scope}" if scope else label,
                    used_percent=percent,
                    resets_at=parse_timestamp(window.get("resetsAt")),
                    window_minutes=minutes,
                )
            )
    return windows, plan


def _account_part(stable_id: str | None) -> str | None:
    if not stable_id or ":" not in stable_id:
        return None
    account = stable_id.split(":", 1)[1]
    return None if account == "-" else account


def plan_label(plan: str | None) -> str | None:
    if not plan or plan == "unknown":
        return None
    return " ".join(part.capitalize() for part in plan.replace("_", " ").split())


def decode_jwt_claims(token: Any) -> dict[str, Any]:
    if not isinstance(token, str) or token.count(".") < 2:
        return {}
    segment = token.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (ValueError, TypeError):
        return {}
    return claims if isinstance(claims, dict) else {}


def _rpc_failure(error: RpcError) -> ProbeResult:
    text = str(error)
    lowered = text.lower()
    if error.timeout:
        return ProbeResult.failure("timeout", f"codex app-server did not answer {text} in time.")
    if any(word in lowered for word in ("auth", "login", "logged", "token", "unauthorized", "401")):
        return ProbeResult.failure("auth", "Codex rejected the saved ChatGPT login.")
    return ProbeResult.failure("unavailable", f"Codex limits unavailable: {text[:200]}")


class AppServerSession:
    """A ``codex app-server`` child speaking newline-delimited JSON-RPC.

    A reader thread feeds stdout lines into a queue so every request waits with
    a real timeout on every platform. ``close`` always reaps the child (and its
    process group on POSIX).
    """

    def __init__(self, argv: list[str], *, env: dict[str, str]) -> None:
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
                subprocess, "CREATE_NO_WINDOW", 0
            )
        else:
            kwargs["start_new_session"] = True
        self._process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            **kwargs,
        )
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._next_id = 0
        threading.Thread(target=self._pump, name="codex-usage-rpc", daemon=True).start()

    def _pump(self) -> None:
        stdout = self._process.stdout
        try:
            for line in stdout if stdout else ():
                self._lines.put(line)
        except (OSError, ValueError):
            pass
        finally:
            self._lines.put(None)

    def _send(self, message: dict[str, Any]) -> None:
        stdin = self._process.stdin
        if stdin is None:
            raise RpcError("stdin closed")
        try:
            stdin.write(json.dumps(message) + "\n")
            stdin.flush()
        except (OSError, ValueError) as error:
            raise RpcError(f"write failed: {error}") from error

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"method": method, "params": params})

    def request(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        self._next_id += 1
        request_id = self._next_id
        self._send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RpcError(method, timeout=True)
            try:
                line = self._lines.get(timeout=remaining)
            except queue.Empty:
                raise RpcError(method, timeout=True) from None
            if line is None:
                raise RpcError(f"app-server exited during {method}")
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if not isinstance(message, dict) or message.get("id") != request_id:
                continue  # notifications, or answers to abandoned requests
            if isinstance(message.get("error"), dict):
                raise RpcError(str(message["error"].get("message") or "request failed"))
            result = message.get("result")
            return result if isinstance(result, dict) else {}

    def close(self) -> None:
        process = self._process
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        if process.poll() is None:
            _signal_tree(process, force=False)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                _signal_tree(process, force=True)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass


def _signal_tree(process: subprocess.Popen[str], *, force: bool) -> None:
    """Stop the app-server and everything it started.

    On Windows ``codex`` usually resolves to an npm ``codex.cmd`` shim, so the
    child is cmd.exe -> node -> codex.exe; only a tree kill reaches codex.exe.
    """
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
    except (OSError, subprocess.SubprocessError):
        pass


def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
