from __future__ import annotations

import ssl
import sys
import types

from backend import launcher
from mcp_server import server as mcp_server


def test_launcher_starts_uvicorn_with_requested_options(monkeypatch) -> None:
    calls: list[tuple[object, dict[str, object]]] = []
    monkeypatch.setattr(launcher.uvicorn, "run", lambda app, **kwargs: calls.append((app, kwargs)))

    result = launcher.main(["--host", "127.0.0.2", "--port", "9123", "--no-access-log"])

    assert result == 0
    assert calls == [
        (
            launcher.app,
            {"host": "127.0.0.2", "port": 9123, "access_log": False},
        )
    ]


def test_launcher_can_run_the_bundled_mcp_server(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(mcp_server, "main", lambda: calls.append("mcp"))

    result = launcher.main(["--mcp-server"])

    assert result == 0
    assert calls == ["mcp"]


def _without_default_certificates(monkeypatch) -> None:
    missing = ssl.DefaultVerifyPaths(None, None, "SSL_CERT_FILE", "/usr/lib/ssl/cert.pem", "SSL_CERT_DIR", "/usr/lib/ssl/certs")
    monkeypatch.setattr(launcher.sys, "platform", "linux")
    monkeypatch.setattr(launcher.ssl, "get_default_verify_paths", lambda: missing)


def test_ca_bundle_falls_back_to_the_system_certificates(monkeypatch, tmp_path) -> None:
    _without_default_certificates(monkeypatch)
    system_bundle = tmp_path / "ca-bundle.crt"
    system_bundle.write_text("certificates")
    monkeypatch.setattr(launcher, "SYSTEM_CA_BUNDLES", (str(tmp_path / "absent.crt"), str(system_bundle)))
    environ: dict[str, str] = {}

    launcher.ensure_ca_bundle(environ)

    assert environ == {"SSL_CERT_FILE": str(system_bundle)}


def test_ca_bundle_uses_certifi_when_the_system_has_none(monkeypatch, tmp_path) -> None:
    _without_default_certificates(monkeypatch)
    monkeypatch.setattr(launcher, "SYSTEM_CA_BUNDLES", (str(tmp_path / "absent.crt"),))
    monkeypatch.setitem(sys.modules, "certifi", types.SimpleNamespace(where=lambda: "/bundle/certifi/cacert.pem"))
    environ: dict[str, str] = {}

    launcher.ensure_ca_bundle(environ)

    assert environ == {"SSL_CERT_FILE": "/bundle/certifi/cacert.pem"}


def test_ca_bundle_keeps_the_users_own_override(monkeypatch, tmp_path) -> None:
    _without_default_certificates(monkeypatch)
    system_bundle = tmp_path / "ca-bundle.crt"
    system_bundle.write_text("certificates")
    monkeypatch.setattr(launcher, "SYSTEM_CA_BUNDLES", (str(system_bundle),))

    for override in ({"SSL_CERT_FILE": "/corp/ca.pem"}, {"SSL_CERT_DIR": "/corp/certs"}):
        environ = dict(override)
        launcher.ensure_ca_bundle(environ)
        assert environ == override


def test_ca_bundle_leaves_working_defaults_alone(monkeypatch, tmp_path) -> None:
    working = ssl.DefaultVerifyPaths(None, "/etc/ssl/certs", "SSL_CERT_FILE", "/etc/ssl/cert.pem", "SSL_CERT_DIR", "/etc/ssl/certs")
    monkeypatch.setattr(launcher.sys, "platform", "linux")
    monkeypatch.setattr(launcher.ssl, "get_default_verify_paths", lambda: working)
    system_bundle = tmp_path / "ca-bundle.crt"
    system_bundle.write_text("certificates")
    monkeypatch.setattr(launcher, "SYSTEM_CA_BUNDLES", (str(system_bundle),))
    environ: dict[str, str] = {}

    launcher.ensure_ca_bundle(environ)

    assert environ == {}
