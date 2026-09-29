from __future__ import annotations

import base64
import http.client
import json
import sys
import textwrap
import threading
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.memory import HermesMemoryStore
from backend.usage import AccountIdentity, ProbeResult, ProviderHome, UsageService, UsageWindow
from backend.usage.claude import ClaudeUsageAdapter, parse_usage_payload
from backend.usage.codex import AppServerSession, CodexUsageAdapter, RpcError, parse_rate_limits

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
SECRET = "sk-ant-oat01-SECRET-TOKEN"


# --------------------------------------------------------------------- claude


def claude_payload() -> dict:
    # Shape captured from the live endpoint (values changed).
    return {
        "five_hour": {"utilization": 27.0, "resets_at": "2026-09-29T14:50:00.396804+00:00", "limit_dollars": None},
        "seven_day": {"utilization": 15.0, "resets_at": "2026-10-02T17:00:00.396829+00:00"},
        "seven_day_oauth_apps": None,
        "seven_day_opus": None,
        "seven_day_sonnet": {"utilization": None, "resets_at": None},
        "iguana_necktie": {"utilization": 0.0, "resets_at": "2026-11-05T07:59:00+00:00"},
        "extra_usage": {"is_enabled": False, "utilization": None},
        "limits": [
            {"kind": "session", "group": "session", "percent": 27, "resets_at": "2026-09-29T14:50:00+00:00", "scope": None},
            {"kind": "weekly_all", "group": "weekly", "percent": 15, "resets_at": "2026-10-02T17:00:00+00:00", "scope": None},
            {
                "kind": "weekly_scoped",
                "group": "weekly",
                "percent": 1,
                "resets_at": "2026-10-02T17:00:00+00:00",
                "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None},
            },
            {"kind": "weekly_scoped", "percent": 99, "scope": {"model": {"display_name": "Fable"}}},
            {"kind": "weekly_scoped", "percent": "unknown", "scope": {"model": {"display_name": "Opus"}}},
            {"kind": "weekly_scoped", "percent": 5, "scope": {"model": {"display_name": "  "}}},
        ],
    }


def test_claude_payload_reads_percentages_on_their_own_scale() -> None:
    windows = {window.id: window for window in parse_usage_payload(claude_payload())}

    assert list(windows) == ["session", "weekly", "weekly:fable"]
    assert windows["session"].used_percent == 27.0
    assert windows["session"].window_minutes == 300
    assert windows["weekly"].used_percent == 15.0
    # 1 means 1%, not 100%: the endpoint speaks 0..100 and never fractions.
    assert windows["weekly:fable"].used_percent == 1.0
    assert windows["weekly:fable"].label == "Weekly · Fable"
    assert windows["session"].resets_at == datetime(2026, 9, 29, 14, 50, 0, 396804, tzinfo=timezone.utc)


def test_claude_payload_never_turns_unknown_into_zero() -> None:
    payload = {
        "five_hour": {"utilization": None, "resets_at": None},
        "seven_day": {"utilization": "12", "resets_at": None},
        "seven_day_opus": {"utilization": float("nan")},
        "seven_day_sonnet": {"utilization": -3},
        "limits": [{"kind": "weekly_scoped", "percent": True, "scope": {"model": {"display_name": "Fable"}}}],
    }
    assert parse_usage_payload(payload) == []


def test_claude_payload_does_not_repeat_a_flat_model_bucket() -> None:
    windows = parse_usage_payload(
        {
            "seven_day_opus": {"utilization": 30.0},
            "limits": [{"kind": "weekly_scoped", "percent": 30, "scope": {"model": {"display_name": "Opus 4.1"}}}],
        }
    )
    assert [(window.id, window.label) for window in windows] == [("weekly:opus", "Weekly · Opus")]


def test_claude_payload_falls_back_to_limits_array_and_clamps() -> None:
    windows = parse_usage_payload(
        {"limits": [{"kind": "session", "percent": 140, "resets_at": 1790712123}, {"kind": "weekly_all", "percent": 3}]}
    )
    assert [(window.id, window.used_percent) for window in windows] == [("session", 100.0), ("weekly", 3.0)]
    assert windows[0].resets_at == datetime.fromtimestamp(1790712123, timezone.utc)


def write_claude_home(path: Path, *, account_uuid: str | None, email: str, expires_at_ms: int, token: str = SECRET, metadata: Path | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".credentials.json").write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": token,
                    "refreshToken": "refresh-SECRET",
                    "expiresAt": expires_at_ms,
                    "subscriptionType": "max",
                    "rateLimitTier": "default_claude_max_20x",
                }
            }
        ),
        encoding="utf-8",
    )
    if account_uuid is not None:
        (metadata or path / ".claude.json").write_text(
            json.dumps(
                {
                    "oauthAccount": {
                        "accountUuid": account_uuid,
                        "organizationUuid": "org-1",
                        "emailAddress": email,
                        "displayName": "Ada",
                        "organizationName": "Ada's Org",
                    }
                }
            ),
            encoding="utf-8",
        )


def future_ms(hours: float = 2) -> int:
    return int((time.time() + hours * 3600) * 1000)


def test_claude_discovers_default_switcher_and_account_homes(tmp_path: Path) -> None:
    write_claude_home(tmp_path / ".claude", account_uuid="acct-a", email="a@example.com", expires_at_ms=future_ms(), metadata=tmp_path / ".claude.json")
    write_claude_home(tmp_path / "profiles" / "work", account_uuid="acct-b", email="b@example.com", expires_at_ms=future_ms())
    write_claude_home(tmp_path / ".claude-accounts" / "spare", account_uuid="acct-c", email="c@example.com", expires_at_ms=future_ms())
    (tmp_path / ".claude-accounts" / "empty").mkdir()
    switcher = tmp_path / ".config" / "claude-account-switcher"
    switcher.mkdir(parents=True)
    (switcher / "profiles.json").write_text(
        json.dumps(
            {
                "profiles": {
                    "default": {"config_dir": str(tmp_path / ".claude")},
                    "work": {"config_dir": str(tmp_path / "profiles" / "work")},
                    "missing": {"config_dir": str(tmp_path / "nowhere")},
                }
            }
        ),
        encoding="utf-8",
    )

    adapter = ClaudeUsageAdapter(home_dir=tmp_path, env={})
    homes = adapter.discover_homes()

    assert [(home.label, home.source) for home in homes] == [("default", "default"), ("work", "switcher"), ("spare", "accounts-dir")]
    identity = adapter.read_identity(homes[0])
    assert identity.email == "a@example.com"
    assert identity.plan == "Max 20x"
    assert identity.credential_state == "ok"
    assert identity.stable_id == "org-1:acct-a"
    assert SECRET not in repr(identity)
    assert adapter.read_identity(homes[1]).stable_id == "org-1:acct-b"


def test_claude_identity_reports_expired_and_missing_logins(tmp_path: Path) -> None:
    write_claude_home(tmp_path / "old", account_uuid="acct-a", email="a@example.com", expires_at_ms=int((time.time() - 60) * 1000))
    (tmp_path / "gone").mkdir()
    (tmp_path / "gone" / ".claude.json").write_text(json.dumps({"oauthAccount": {"accountUuid": "acct-g"}}), encoding="utf-8")
    adapter = ClaudeUsageAdapter(home_dir=tmp_path, env={"CONTEXT_WORKSPACE_USAGE_CLAUDE_HOMES": f"{tmp_path / 'old'}:{tmp_path / 'gone'}"})

    homes = {home.label: home for home in adapter.discover_homes()}

    assert adapter.read_identity(homes["old"]).credential_state == "expired"
    assert adapter.read_identity(homes["gone"]).credential_state == "missing"


PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"


def profile_body(account_uuid: str = "acct-a", org_uuid: str = "org-1") -> dict:
    return {"account": {"uuid": account_uuid, "email": "a@example.com"}, "organization": {"uuid": org_uuid}}


class FakeHttp:
    def __init__(
        self,
        status: int = 200,
        body: dict | None = None,
        headers: dict | None = None,
        error: Exception | None = None,
        profile: dict | None = None,
    ) -> None:
        self.status = status
        self.body = body if body is not None else claude_payload()
        self.headers = headers or {}
        self.error = error
        self.profile = profile if profile is not None else profile_body()
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: dict[str, str], timeout: float) -> tuple[int, dict[str, str], bytes]:
        assert timeout <= 15
        self.calls.append((url, headers))
        if self.error:
            raise self.error
        if url == PROFILE_URL:
            return 200, {}, json.dumps(self.profile).encode("utf-8")
        return self.status, self.headers, json.dumps(self.body).encode("utf-8")

    def urls(self) -> list[str]:
        return [url for url, _ in self.calls]


def claude_home(tmp_path: Path, expires_at_ms: int | None = None) -> tuple[ClaudeUsageAdapter, ProviderHome, FakeHttp]:
    write_claude_home(tmp_path / "home", account_uuid="acct-a", email="a@example.com", expires_at_ms=expires_at_ms or future_ms())
    http = FakeHttp()
    adapter = ClaudeUsageAdapter(home_dir=tmp_path, env={}, http_get=http)
    home = ProviderHome("claude", tmp_path / "home", "home", "config")
    return adapter, home, http


def test_claude_probe_sends_token_only_to_usage_endpoint(tmp_path: Path) -> None:
    adapter, home, http = claude_home(tmp_path)

    result = adapter.probe(home, adapter.read_identity(home))

    assert result.ok
    assert [window.id for window in result.windows] == ["session", "weekly", "weekly:fable"]
    assert http.urls() == [PROFILE_URL, USAGE_URL]
    for _, headers in http.calls:
        assert headers["Authorization"] == f"Bearer {SECRET}"
        assert headers["anthropic-beta"] == "oauth-2025-04-20"
    assert SECRET not in repr(result)

    # The token's account is confirmed once per credential-file version.
    adapter.probe(home, adapter.read_identity(home))
    assert http.urls() == [PROFILE_URL, USAGE_URL, USAGE_URL]
    write_claude_home(tmp_path / "home", account_uuid="acct-a", email="a@example.com", expires_at_ms=future_ms(3), token=SECRET + "-refreshed")
    adapter.probe(home, adapter.read_identity(home))
    assert http.urls()[-2:] == [PROFILE_URL, USAGE_URL]


def test_claude_probe_refuses_a_token_that_belongs_to_another_account(tmp_path: Path) -> None:
    # Mid-login: .credentials.json already holds account B's token while
    # .claude.json still names account A.
    adapter, home, http = claude_home(tmp_path)
    http.profile = profile_body(account_uuid="acct-b")

    result = adapter.probe(home, adapter.read_identity(home))

    assert not result.ok and result.error_kind == "protocol"
    assert http.urls() == [PROFILE_URL]  # B's windows are never even fetched


def test_claude_metadata_without_an_organization_still_verifies(tmp_path: Path) -> None:
    adapter, home, http = claude_home(tmp_path)
    (tmp_path / "home" / ".claude.json").write_text(
        json.dumps({"oauthAccount": {"accountUuid": "acct-a", "emailAddress": "a@example.com"}}), encoding="utf-8"
    )

    identity = adapter.read_identity(home)
    result = adapter.probe(home, identity)

    assert identity.stable_id == "-:acct-a"
    assert result.ok
    assert http.urls() == [PROFILE_URL, USAGE_URL]


def test_claude_marks_half_written_files_unreadable_and_parses_metadata_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import backend.usage.claude as claude_module

    adapter, home, _ = claude_home(tmp_path)
    reads: list[str] = []
    real_read = claude_module.read_bytes
    monkeypatch.setattr(claude_module, "read_bytes", lambda path: reads.append(path.name) or real_read(path))

    assert adapter.read_identity(home).unreadable is False
    adapter.read_identity(home)
    assert reads.count(".claude.json") == 1  # unchanged metadata is not re-parsed

    (tmp_path / "home" / ".claude.json").write_text('{"oauthAccount": {"accountUu', encoding="utf-8")
    assert adapter.read_identity(home).unreadable is True
    (tmp_path / "home" / ".credentials.json").write_text("", encoding="utf-8")
    write_claude_home(tmp_path / "home", account_uuid="acct-a", email="a@example.com", expires_at_ms=future_ms())
    (tmp_path / "home" / ".credentials.json").write_text('{"claudeAiOa', encoding="utf-8")
    assert adapter.read_identity(home).unreadable is True


def test_claude_requests_never_follow_redirects_with_the_token() -> None:
    import http.server
    import threading as _threading

    from backend.usage.claude import _urllib_get

    seen: list[str | None] = []

    class Target(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            seen.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    target = http.server.HTTPServer(("127.0.0.1", 0), Target)

    class Redirect(Target):
        def do_GET(self) -> None:
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{target.server_port}/steal")
            self.end_headers()

    origin = http.server.HTTPServer(("127.0.0.1", 0), Redirect)
    for server in (target, origin):
        _threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        status, _, _ = _urllib_get(f"http://127.0.0.1:{origin.server_port}/usage", {"Authorization": f"Bearer {SECRET}"}, 5)
    finally:
        origin.shutdown()
        target.shutdown()

    assert status == 302
    assert seen == []


def test_claude_probe_skips_the_network_for_an_expired_token(tmp_path: Path) -> None:
    adapter, home, http = claude_home(tmp_path, expires_at_ms=int((time.time() - 5) * 1000))

    result = adapter.probe(home, adapter.read_identity(home))

    assert not result.ok and result.error_kind == "expired"
    assert http.calls == []


@pytest.mark.parametrize(
    ("http", "kind", "retry_after"),
    [
        (FakeHttp(status=401), "auth", None),
        (FakeHttp(status=429, headers={"retry-after": "120"}), "rate_limited", 120.0),
        (FakeHttp(status=503), "unavailable", None),
        (FakeHttp(body={"five_hour": None}), "unavailable", None),
        (FakeHttp(error=TimeoutError("slow")), "timeout", None),
        (FakeHttp(error=OSError("no route")), "network", None),
        (FakeHttp(error=http.client.IncompleteRead(b"{")), "network", None),
    ],
)
def test_claude_probe_classifies_failures(tmp_path: Path, http: FakeHttp, kind: str, retry_after: float | None) -> None:
    adapter, home, _ = claude_home(tmp_path)
    adapter._http_get = http

    result = adapter.probe(home, adapter.read_identity(home))

    assert not result.ok
    assert result.error_kind == kind
    assert result.retry_after_seconds == retry_after
    assert SECRET not in (result.message or "")


def test_claude_profile_failures_are_classified_like_usage_failures(tmp_path: Path) -> None:
    adapter, home, _ = claude_home(tmp_path)
    calls: list[str] = []

    def reject(url: str, headers: dict[str, str], timeout: float) -> tuple[int, dict[str, str], bytes]:
        calls.append(url)
        return 401, {}, b""

    adapter._http_get = reject
    result = adapter.probe(home, adapter.read_identity(home))

    assert not result.ok and result.error_kind == "auth"
    assert calls == [PROFILE_URL]


# ---------------------------------------------------------------------- codex


def fake_jwt(claims: dict) -> str:
    def segment(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{segment({'alg': 'none'})}.{segment(claims)}.signature"


def write_codex_home(
    path: Path,
    *,
    user: str,
    account: str,
    email: str,
    plan: str = "plus",
    access_exp: float | None = None,
    last_refresh: str | None = None,
) -> None:
    path.mkdir(parents=True, exist_ok=True)
    claims = {
        "email": email,
        "name": "Ada",
        "sub": f"auth0|{user}",
        "https://api.openai.com/auth": {"chatgpt_user_id": user, "chatgpt_account_id": account, "chatgpt_plan_type": plan},
    }
    (path / "auth.json").write_text(
        json.dumps(
            {
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": None,
                "tokens": {
                    "id_token": fake_jwt(claims),
                    "access_token": fake_jwt({"exp": access_exp, "secret": "codex-SECRET"}) if access_exp else "codex-SECRET",
                    "refresh_token": "codex-refresh-SECRET",
                    "account_id": account,
                },
                **({"last_refresh": last_refresh} if last_refresh else {}),
            }
        ),
        encoding="utf-8",
    )


RATE_LIMITS = {
    "rateLimits": {
        "limitId": "codex",
        "primary": {"usedPercent": 34, "windowDurationMins": 300, "resetsAt": 1790712123},
        "secondary": {"usedPercent": 39, "windowDurationMins": 10080, "resetsAt": 1791072032},
        "planType": "plus",
    },
    "rateLimitsByLimitId": {
        "gpt-reserve": {"limitId": "gpt-reserve", "limitName": None, "primary": {"usedPercent": 0, "windowDurationMins": 10080}, "secondary": None},
        "codex": {
            "limitId": "codex",
            "primary": {"usedPercent": 34, "windowDurationMins": 300, "resetsAt": 1790712123},
            "secondary": {"usedPercent": 39, "windowDurationMins": 10080, "resetsAt": 1791072032},
            "planType": "plus",
        },
    },
}


def test_codex_rate_limits_prefer_the_multi_bucket_view() -> None:
    windows, plan = parse_rate_limits(RATE_LIMITS)

    assert plan == "Plus"
    assert [(window.id, window.label, window.used_percent) for window in windows] == [
        ("codex:300", "Session", 34.0),
        ("codex:10080", "Weekly", 39.0),
        ("gpt-reserve:10080", "Weekly · gpt-reserve", 0.0),
    ]
    assert windows[0].resets_at == datetime.fromtimestamp(1790712123, timezone.utc)


def test_codex_rate_limits_fall_back_to_single_bucket_and_skip_unknown() -> None:
    windows, plan = parse_rate_limits(
        {"rateLimits": {"primary": {"usedPercent": None, "windowDurationMins": 300}, "secondary": {"usedPercent": 12, "windowDurationMins": 10080}}}
    )
    assert plan is None
    assert [(window.id, window.used_percent) for window in windows] == [("codex:10080", 12.0)]


def test_codex_discovers_homes_and_reads_identity_from_claims(tmp_path: Path) -> None:
    write_codex_home(tmp_path / ".codex", user="user-1", account="acct-1", email="a@example.com")
    write_codex_home(tmp_path / ".codex-accounts" / "account1", user="user-1", account="acct-1", email="a@example.com")
    write_codex_home(tmp_path / ".codex-accounts" / "account2", user="user-2", account="acct-2", email="b@example.com", plan="pro")
    (tmp_path / "apikey").mkdir()
    (tmp_path / "apikey" / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "sk-SECRET", "tokens": None}), encoding="utf-8")
    adapter = CodexUsageAdapter(home_dir=tmp_path, env={"CONTEXT_WORKSPACE_USAGE_CODEX_HOMES": str(tmp_path / "apikey")})

    homes = adapter.discover_homes()
    identities = {home.label: adapter.read_identity(home) for home in homes}

    assert [home.label for home in homes] == ["default", "account1", "account2", "apikey"]
    assert identities["default"].stable_id == identities["account1"].stable_id == "user-1:acct-1"
    assert identities["account2"].email == "b@example.com"
    assert identities["account2"].plan == "Pro"
    assert identities["apikey"].credential_state == "unsupported"
    assert all("SECRET" not in repr(identity) for identity in identities.values())


def test_codex_never_probes_a_login_it_would_force_codex_to_refresh(tmp_path: Path) -> None:
    now = time.time()
    iso = lambda seconds_ago: datetime.fromtimestamp(now - seconds_ago, timezone.utc).isoformat()
    write_codex_home(tmp_path / "fresh", user="u1", account="a1", email="a@example.com", access_exp=now + 6 * 86400, last_refresh=iso(4 * 86400))
    write_codex_home(tmp_path / "idle", user="u2", account="a2", email="b@example.com", access_exp=now + 2 * 86400, last_refresh=iso(8 * 86400))
    write_codex_home(tmp_path / "lapsed", user="u3", account="a3", email="c@example.com", access_exp=now - 80 * 86400, last_refresh=iso(90 * 86400))
    write_codex_home(tmp_path / "ending", user="u4", account="a4", email="d@example.com", access_exp=now + 600)
    homes = ":".join(str(tmp_path / name) for name in ("fresh", "idle", "lapsed", "ending"))
    adapter = CodexUsageAdapter(home_dir=tmp_path, env={"CONTEXT_WORKSPACE_USAGE_CODEX_HOMES": homes})

    states = {home.label: adapter.read_identity(home).credential_state for home in adapter.discover_homes()}

    assert states == {"fresh": "ok", "idle": "expired", "lapsed": "expired", "ending": "expired"}
    assert "rotates" in adapter.expired_hint(adapter.discover_homes()[1])


class ScriptedSession:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.requests: list[str] = []
        self.notifications: list[str] = []
        self.closed = False

    def request(self, method: str, params: dict, timeout: float) -> dict:
        self.requests.append(method)
        response = self.responses.get(method, RpcError(method, timeout=True))
        if isinstance(response, Exception):
            raise response
        return response  # type: ignore[return-value]

    def notify(self, method: str, params: dict) -> None:
        self.notifications.append(method)

    def close(self) -> None:
        self.closed = True


def codex_probe(tmp_path: Path, responses: dict[str, object]) -> tuple[ProbeResult, ScriptedSession, ProviderHome]:
    write_codex_home(tmp_path / "home", user="user-1", account="acct-1", email="a@example.com")
    session = ScriptedSession(responses)
    seen_homes: list[ProviderHome] = []

    def factory(home: ProviderHome) -> ScriptedSession:
        seen_homes.append(home)
        return session

    adapter = CodexUsageAdapter(home_dir=tmp_path, env={}, session_factory=factory)
    home = ProviderHome("codex", tmp_path / "home", "home", "config")
    result = adapter.probe(home, adapter.read_identity(home))
    assert seen_homes == [home]
    return result, session, home


def test_codex_probe_reads_limits_and_skips_account_read_when_plan_known(tmp_path: Path) -> None:
    result, session, _ = codex_probe(tmp_path, {"initialize": {}, "account/rateLimits/read": RATE_LIMITS})

    assert result.ok and result.plan == "Plus"
    assert session.requests == ["initialize", "account/rateLimits/read"]
    assert session.notifications == ["initialized"]
    assert session.closed


def test_codex_probe_rejects_limits_reported_for_another_account(tmp_path: Path) -> None:
    result, session, _ = codex_probe(tmp_path, {"initialize": {}, "account/rateLimits/read": {**RATE_LIMITS, "accountId": "acct-other"}})
    assert not result.ok and result.error_kind == "protocol"
    assert session.closed

    matching, _, _ = codex_probe(tmp_path, {"initialize": {}, "account/rateLimits/read": {**RATE_LIMITS, "accountId": "acct-1"}})
    assert matching.ok


def test_codex_adapter_close_stops_new_probes(tmp_path: Path) -> None:
    write_codex_home(tmp_path / "home", user="user-1", account="acct-1", email="a@example.com")
    session = ScriptedSession({"initialize": {}, "account/rateLimits/read": RATE_LIMITS})
    adapter = CodexUsageAdapter(home_dir=tmp_path, env={}, session_factory=lambda home: session)
    home = ProviderHome("codex", tmp_path / "home", "home", "config")
    adapter.close()

    result = adapter.probe(home, adapter.read_identity(home))

    assert not result.ok and session.closed and session.requests == []


def test_codex_probe_keeps_limits_when_account_read_hangs(tmp_path: Path) -> None:
    limits = {"rateLimits": {"primary": {"usedPercent": 10, "windowDurationMins": 300}}}
    result, session, _ = codex_probe(tmp_path, {"initialize": {}, "account/rateLimits/read": limits})

    assert result.ok
    assert [window.used_percent for window in result.windows] == [10.0]
    assert result.plan == "Plus"  # from the id_token claims
    assert session.requests[-1] == "account/read"
    assert session.closed


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (RpcError("account/rateLimits/read", timeout=True), "timeout"),
        (RpcError("not logged in: token expired"), "auth"),
        (RpcError("app-server exited during initialize"), "unavailable"),
    ],
)
def test_codex_probe_classifies_rpc_failures(tmp_path: Path, error: RpcError, kind: str) -> None:
    result, session, _ = codex_probe(tmp_path, {"initialize": {}, "account/rateLimits/read": error})

    assert not result.ok and result.error_kind == kind
    assert session.closed


FAKE_APP_SERVER = textwrap.dedent(
    """
    import json, sys, time
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        if "id" not in message:
            continue
        if method == "initialize":
            print(json.dumps({"method": "configWarning", "params": {}}), flush=True)
            print(json.dumps({"id": message["id"], "result": {"userAgent": "fake"}}), flush=True)
        elif method == "account/rateLimits/read":
            print(json.dumps({"id": message["id"], "result": {"rateLimits": {"primary": {"usedPercent": 42, "windowDurationMins": 300}}}}), flush=True)
        elif method == "account/read":
            time.sleep(60)  # the hang some Codex releases exhibit
    """
)


def test_app_server_session_survives_a_hanging_account_read_and_reaps_the_child(tmp_path: Path) -> None:
    script = tmp_path / "fake_app_server.py"
    script.write_text(FAKE_APP_SERVER, encoding="utf-8")
    write_codex_home(tmp_path / "home", user="user-1", account="acct-1", email="a@example.com", plan="unknown")
    sessions: list[AppServerSession] = []

    def factory(home: ProviderHome) -> AppServerSession:
        session = AppServerSession([sys.executable, str(script)], env={"CODEX_HOME": str(home.path)})
        sessions.append(session)
        return session

    adapter = CodexUsageAdapter(home_dir=tmp_path, env={}, session_factory=factory)
    home = ProviderHome("codex", tmp_path / "home", "home", "config")
    started = time.monotonic()
    result = adapter.probe(home, adapter.read_identity(home))

    assert result.ok
    assert [window.used_percent for window in result.windows] == [42.0]
    assert time.monotonic() - started < 10
    assert sessions[0]._process.poll() is not None


# -------------------------------------------------------------------- service


class FakeClock:
    def __init__(self) -> None:
        self.now = NOW.timestamp()

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeAdapter:
    """Homes map to identities the test can swap, mimicking `claude login` into another account."""

    display_name = "Fake"

    def __init__(self, provider: str = "fake") -> None:
        self.provider = provider
        self.homes: dict[str, str | None] = {}
        self.states: dict[str, str] = {}
        self.fingerprints: dict[str, str] = {}
        self.results: dict[str, ProbeResult] = {}
        self.probes: list[str] = []
        self.gate: threading.Event | None = None
        self.during_probe = None
        self.unreadable: set[str] = set()

    def add(self, label: str, account: str | None) -> None:
        self.homes[label] = account

    def discover_homes(self) -> list[ProviderHome]:
        return [ProviderHome(self.provider, Path(f"/homes/{label}"), label, "default" if label == "default" else "accounts-dir") for label in self.homes]

    def read_identity(self, home: ProviderHome) -> AccountIdentity:
        if home.label in self.unreadable:
            return AccountIdentity(provider=self.provider, stable_id=None, unreadable=True)
        account = self.homes.get(home.label)
        return AccountIdentity(
            provider=self.provider,
            stable_id=account,
            email=f"{account}@example.com" if account else None,
            plan="Max",
            credential_state=self.states.get(home.label, "ok"),  # type: ignore[arg-type]
            credential_fingerprint=self.fingerprints.get(home.label, "fp-1"),
        )

    def probe(self, home: ProviderHome, identity: AccountIdentity) -> ProbeResult:
        self.probes.append(home.label)
        if self.gate is not None:
            assert self.gate.wait(5)
        if self.during_probe is not None:
            self.during_probe()
        return self.results.get(identity.stable_id or "", window_result(identity.stable_id or "", 10))

    def signed_out_hint(self, home: ProviderHome) -> str:
        return f"Sign in to {home.label}."

    def expired_hint(self, home: ProviderHome) -> str:
        return f"Token for {home.label} expired; the CLI refreshes it."


def window_result(account: str, percent: float, resets_at: datetime | None = None) -> ProbeResult:
    return ProbeResult(
        ok=True,
        windows=[UsageWindow(f"session-{account}", "Session", percent, resets_at or NOW + timedelta(hours=3), 300)],
        plan="Max 5x",
    )


def make_service(adapter: FakeAdapter, clock: FakeClock, **kwargs) -> UsageService:
    return UsageService([adapter], refresh_interval_seconds=300, clock=clock, discovery_ttl_seconds=0, **kwargs)


def settle(service: UsageService) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        snapshot = service.snapshot(schedule=False)
        if not any(record["refreshing"] for record in snapshot["accounts"]):
            return snapshot
        time.sleep(0.01)
    raise AssertionError("usage probes did not settle")


def only(snapshot: dict) -> dict:
    (record,) = snapshot["accounts"]
    return record


def test_snapshot_serves_cache_and_probes_in_background() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.gate = threading.Event()
    service = make_service(adapter, clock)

    first = only(service.snapshot())
    assert first["status"] == "loading"
    assert first["windows"] == []
    assert first["refreshing"] is True

    adapter.gate.set()
    record = only(settle(service))
    assert record["status"] == "ok"
    assert record["stale"] is False
    assert record["windows"][0]["used_percent"] == 10.0
    assert record["account"]["email"] == "acct-a@example.com"
    assert record["plan"] == "Max 5x"

    # Within the interval every consumer shares the cached answer.
    for _ in range(5):
        service.snapshot()
    assert adapter.probes == ["default"]
    clock.advance(301)
    settle_after_schedule(service)
    assert adapter.probes == ["default", "default"]


def settle_after_schedule(service: UsageService) -> dict:
    service.snapshot()
    return settle(service)


def test_concurrent_refreshes_share_one_probe() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.gate = threading.Event()
    service = make_service(adapter, clock)

    threads = [threading.Thread(target=service.refresh, kwargs={"wait_seconds": 5}) for _ in range(6)]
    for thread in threads:
        thread.start()
    time.sleep(0.1)
    adapter.gate.set()
    for thread in threads:
        thread.join(5)

    assert adapter.probes == ["default"]
    assert only(service.snapshot(schedule=False))["status"] == "ok"


def test_homes_signed_into_one_account_share_a_record() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.add("account1", "acct-a")
    adapter.add("account2", "acct-b")
    service = make_service(adapter, clock)

    snapshot = settle_after_schedule(service)

    assert sorted(adapter.probes) == ["account2", "default"]
    records = {record["account"]["email"]: record for record in snapshot["accounts"]}
    assert [profile["label"] for profile in records["acct-a@example.com"]["profiles"]] == ["default", "account1"]
    assert records["acct-a@example.com"]["key"] != records["acct-b@example.com"]["key"]


def test_switching_a_home_to_another_account_never_reuses_the_old_windows() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.results["acct-a"] = window_result("acct-a", 88)
    service = make_service(adapter, clock)
    before = only(settle_after_schedule(service))
    assert before["windows"][0]["used_percent"] == 88.0

    adapter.homes["default"] = "acct-b"
    adapter.gate = threading.Event()
    after = only(service.snapshot())

    assert after["key"] != before["key"]
    assert after["status"] == "loading"
    assert after["windows"] == []
    adapter.gate.set()
    settled = only(settle(service))
    assert settled["account"]["email"] == "acct-b@example.com"
    assert settled["windows"][0]["used_percent"] == 10.0


def test_probe_result_is_discarded_when_the_account_changes_mid_probe() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.results["acct-a"] = window_result("acct-a", 55)

    def switch_account() -> None:
        adapter.homes["default"] = "acct-b"
        adapter.during_probe = None

    adapter.during_probe = switch_account
    service = make_service(adapter, clock)
    service.snapshot()
    settle(service)

    record = only(service.snapshot(schedule=False))
    assert record["account"]["email"] == "acct-b@example.com"
    assert all(window["used_percent"] != 55.0 for window in record["windows"])


def test_a_discarded_probe_holds_the_home_instead_of_reprobing_every_poll() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")

    def flip() -> None:
        adapter.homes["default"] = "acct-b" if adapter.homes["default"] == "acct-a" else "acct-a"

    adapter.during_probe = flip
    service = make_service(adapter, clock)
    for _ in range(5):
        clock.advance(3)
        settle_after_schedule(service)
    assert adapter.probes == ["default"]

    clock.advance(60)
    settle_after_schedule(service)
    assert adapter.probes == ["default", "default"]


def test_a_credential_file_caught_mid_rewrite_keeps_the_account() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    service = make_service(adapter, clock)
    key = only(settle_after_schedule(service))["key"]

    adapter.unreadable.add("default")
    record = only(settle_after_schedule(service))

    assert record["key"] == key
    assert record["status"] == "ok"
    assert record["windows"][0]["used_percent"] == 10.0
    assert adapter.probes == ["default"]


def test_failed_refresh_keeps_last_windows_marked_stale() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    service = make_service(adapter, clock)
    settle_after_schedule(service)

    adapter.results["acct-a"] = ProbeResult.failure("network", "Couldn't reach the provider.")
    clock.advance(301)
    record = only(settle_after_schedule(service))

    assert record["status"] == "stale"
    assert record["stale"] is True
    assert record["message"] == "Couldn't reach the provider."
    assert record["windows"][0]["used_percent"] == 10.0

    # Backoff: the next attempt waits instead of retrying on every poll.
    probes = len(adapter.probes)
    clock.advance(30)
    settle_after_schedule(service)
    assert len(adapter.probes) == probes
    clock.advance(31)
    settle_after_schedule(service)
    assert len(adapter.probes) == probes + 1


def test_windows_past_their_reset_are_dropped_and_trigger_a_refresh() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.results["acct-a"] = window_result("acct-a", 91, resets_at=NOW + timedelta(minutes=2))
    service = make_service(adapter, clock)
    settle_after_schedule(service)

    adapter.results["acct-a"] = ProbeResult.failure("network", "offline")
    clock.advance(180)
    record = only(settle_after_schedule(service))

    assert adapter.probes == ["default", "default"]  # refreshed early, before the 300 s interval
    assert record["windows"] == []  # 91% described a window that is over
    assert record["status"] == "error"


def test_a_window_reported_already_reset_does_not_turn_polls_into_probes() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    stale = UsageWindow("weekly", "Weekly", 70, NOW - timedelta(seconds=5), 10080)
    fresh = UsageWindow("session", "Session", 20, NOW + timedelta(hours=2), 300)
    adapter.results["acct-a"] = ProbeResult(ok=True, windows=[stale, fresh])
    service = make_service(adapter, clock)

    record = only(settle_after_schedule(service))
    for _ in range(10):
        clock.advance(3)
        settle_after_schedule(service)

    assert adapter.probes == ["default"]
    assert [window["id"] for window in record["windows"]] == ["session"]


def test_a_reset_triggers_at_most_one_early_reread_per_minute() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.results["acct-a"] = window_result("acct-a", 50, resets_at=NOW + timedelta(seconds=30))
    service = make_service(adapter, clock)
    settle_after_schedule(service)

    clock.advance(40)  # reset passed, but the last check was only 40 s ago
    settle_after_schedule(service)
    assert adapter.probes == ["default"]
    clock.advance(25)
    settle_after_schedule(service)
    assert adapter.probes == ["default", "default"]


def test_shutdown_releases_a_waiting_refresh() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.gate = threading.Event()
    service = make_service(adapter, clock)
    finished = threading.Event()

    def refresh() -> None:
        service.refresh(wait_seconds=10)
        finished.set()

    thread = threading.Thread(target=refresh)
    thread.start()
    time.sleep(0.1)
    started = time.monotonic()
    service.shutdown()
    assert finished.wait(2)
    assert time.monotonic() - started < 1.5
    adapter.gate.set()
    thread.join(2)


def test_rate_limit_backoff_is_respected_even_by_manual_refresh() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.results["acct-a"] = ProbeResult.failure("rate_limited", "Slow down.", retry_after_seconds=600)
    service = make_service(adapter, clock)
    record = only(settle_after_schedule(service))
    assert record["status"] == "rate_limited"

    clock.advance(120)
    service.refresh(wait_seconds=1)
    assert adapter.probes == ["default"]
    clock.advance(481)
    settle_after_schedule(service)
    assert adapter.probes == ["default", "default"]


def test_auth_failure_waits_for_the_cli_to_rewrite_credentials() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.results["acct-a"] = ProbeResult.failure("auth", "Rejected.")
    service = make_service(adapter, clock)
    record = only(settle_after_schedule(service))
    assert record["status"] == "expired"
    assert "Sign in to default." in record["message"]

    clock.advance(7200)  # no time-based retry of a rejected login
    record = only(settle_after_schedule(service))
    assert adapter.probes == ["default"]
    assert record["next_refresh_at"] is None

    adapter.fingerprints["default"] = "fp-2"  # the CLI refreshed its login
    adapter.results.pop("acct-a")
    record = only(settle_after_schedule(service))
    assert adapter.probes == ["default", "default"]
    assert record["status"] == "ok"


def test_signed_out_and_expired_homes_are_never_probed() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    adapter.add("spare", "acct-b")
    adapter.states["default"] = "expired"
    adapter.states["spare"] = "missing"
    service = make_service(adapter, clock)

    snapshot = settle_after_schedule(service)
    service.refresh(wait_seconds=0.5)

    assert adapter.probes == []
    records = {record["status"]: record for record in snapshot["accounts"]}
    assert set(records) == {"expired", "signed_out"}
    assert records["expired"]["message"] == "Token for default expired; the CLI refreshes it."
    assert all(record["windows"] == [] and record["next_refresh_at"] is None for record in snapshot["accounts"])


def test_expired_login_keeps_recent_windows_but_never_as_live() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    service = make_service(adapter, clock)
    settle_after_schedule(service)

    adapter.states["default"] = "expired"
    clock.advance(30)
    record = only(settle_after_schedule(service))

    assert adapter.probes == ["default"]
    assert record["status"] == "expired"
    assert record["windows"][0]["used_percent"] == 10.0
    assert record["stale"] is True


def test_signed_out_account_drops_its_cached_windows() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    service = make_service(adapter, clock)
    key = only(settle_after_schedule(service))["key"]

    del adapter.homes["default"]
    assert service.snapshot()["accounts"] == []
    adapter.add("default", "acct-a")
    adapter.gate = threading.Event()
    record = only(service.snapshot())
    assert record["key"] == key
    assert record["status"] == "loading" and record["windows"] == []
    adapter.gate.set()
    settle(service)


def test_refresh_rejects_unknown_account_keys() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")
    service = make_service(adapter, clock)

    with pytest.raises(KeyError):
        service.refresh(account_key="fake:0000")


def test_a_raising_adapter_is_contained() -> None:
    adapter, clock = FakeAdapter(), FakeClock()
    adapter.add("default", "acct-a")

    def explode(home: ProviderHome, identity: AccountIdentity) -> ProbeResult:
        raise RuntimeError(SECRET)

    adapter.probe = explode  # type: ignore[method-assign]
    service = make_service(adapter, clock)
    record = only(settle_after_schedule(service))

    assert record["status"] == "error"
    assert SECRET not in json.dumps(record)


# ------------------------------------------------------------------------ api


class FakeHermes:
    def __init__(self, root: Path) -> None:
        self.hermes_home = root / ".hermes"


def test_usage_api_contract(tmp_path: Path) -> None:
    adapter, clock = FakeAdapter("claude"), FakeClock()
    adapter.display_name = "Claude"
    adapter.add("default", "acct-a")
    service = make_service(adapter, clock)
    memory = HermesMemoryStore(memory_path=tmp_path / "MEMORY.md")
    client = TestClient(create_app(memory=memory, hermes=FakeHermes(tmp_path), usage=service))

    first = client.get("/usage/accounts")
    assert first.status_code == 200
    settle(service)
    response = client.post("/usage/refresh", json={"provider": "claude"})

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"accounts", "generated_at", "refresh_interval_seconds"}
    assert payload["refresh_interval_seconds"] == 300
    record = payload["accounts"][0]
    assert set(record) == {
        "key", "provider", "provider_name", "account", "profiles", "plan", "status", "message",
        "windows", "stale", "refreshing", "fetched_at", "checked_at", "next_refresh_at",
    }
    assert set(record["account"]) == {"email", "display_name", "organization", "identified"}
    assert record["provider"] == "claude" and record["status"] == "ok"
    assert record["windows"] == [
        {"id": "session-acct-a", "label": "Session", "used_percent": 10.0, "resets_at": "2026-09-29T15:00:00Z", "window_minutes": 300}
    ]
    assert "acct-a" not in record["key"]  # the stable id is hashed, not exposed

    assert client.post("/usage/refresh", json={"account_key": "claude:0000000000000000"}).status_code == 404
    assert client.post("/usage/refresh", json={"provider": "../etc"}).status_code == 422
    service.shutdown()


def test_usage_records_never_carry_credentials(tmp_path: Path) -> None:
    write_claude_home(tmp_path / ".claude", account_uuid="acct-a", email="a@example.com", expires_at_ms=future_ms(), metadata=tmp_path / ".claude.json")
    write_codex_home(tmp_path / ".codex", user="user-1", account="acct-1", email="c@example.com")
    claude = ClaudeUsageAdapter(home_dir=tmp_path, env={}, http_get=FakeHttp())
    codex = CodexUsageAdapter(
        home_dir=tmp_path,
        env={},
        session_factory=lambda home: ScriptedSession({"initialize": {}, "account/rateLimits/read": RATE_LIMITS}),
    )
    service = UsageService([claude, codex], refresh_interval_seconds=300, discovery_ttl_seconds=0)

    service.snapshot()
    text = json.dumps(settle(service))
    service.shutdown()

    assert '"status": "ok"' in text
    for secret in (SECRET, "refresh-SECRET", "codex-SECRET", "codex-refresh-SECRET", "acct-a", "user-1", "acct-1"):
        assert secret not in text
