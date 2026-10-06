"""`athena remote`: driven against a fake Electron control host over real HTTP."""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from cli import __main__ as cli_main
from cli import remote

CLAUDE_ID = "1759400000000-3f9c2a1b4e5d"
CODEX_ID = "1759400000500-3f9d77aa0012"
SHELL_ID = "1759400001000-c0ffee123456"

SNAPSHOT = "\x1b[1mwelcome\x1b[0m\r\n$ claude\r\n"
LIVE = "héllo wörld\r\n"  # non-ASCII on purpose: the stream splits inside "é"
BUFFER = "line1\r\nline2\r\nline3\r\n"


def _terminals() -> list[dict[str, Any]]:
    base = {"pid": 1, "exitCode": None, "error": None, "providerSessionId": None}
    return [
        {**base, "id": CLAUDE_ID, "title": "Claude Code", "kind": "claude", "workspace": "/home/remote/src/app",
         "status": "running", "createdAt": "2026-10-01T10:00:00.000Z"},
        {**base, "id": CODEX_ID, "title": "Codex", "kind": "codex", "workspace": "/home/remote/src/app",
         "status": "running", "createdAt": "2026-10-01T10:00:01.000Z"},
        {**base, "id": SHELL_ID, "title": "Shell", "kind": "shell", "workspace": "/home/remote",
         "status": "exited", "exitCode": 0, "createdAt": "2026-10-01T10:00:02.000Z"},
    ]


@dataclass
class Seen:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: Any


class FakeHost:
    """A minimal Electron control API (see client/electron/control-server.ts)."""

    def __init__(self, *, token: str | None = None, homedir: str = "/home/remote") -> None:
        self.token = token
        self.homedir = homedir
        self.terminals = _terminals()
        self.requests: list[Seen] = []
        self.spawn_reply: tuple[int, dict[str, Any]] | None = None
        host = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:  # keep pytest output clean
                pass

            def do_GET(self) -> None:  # noqa: N802
                host.handle(self, "GET")

            def do_POST(self) -> None:  # noqa: N802
                host.handle(self, "POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def bodies(self, path: str) -> list[Any]:
        return [seen.body for seen in self.requests if seen.path == path]

    # -- request handling --------------------------------------------------- #
    def handle(self, req: BaseHTTPRequestHandler, method: str) -> None:
        parts = urlsplit(req.path)
        path = parts.path
        length = int(req.headers.get("Content-Length") or 0)
        body = json.loads(req.rfile.read(length)) if length else None
        self.requests.append(Seen(method, path, parse_qs(parts.query), dict(req.headers), body))

        if method == "GET" and path == "/health":
            return self.send(req, 200, {"status": "ok", "service": "electron-control"})
        if self.token and req.headers.get("Authorization") != f"Bearer {self.token}":
            return self.send(req, 401, {"error": "Missing or invalid remote access token."})
        if method == "GET" and path == "/machine":
            return self.send(req, 200, {"hostname": "surface", "platform": "linux", "arch": "x64",
                                        "version": "0.3.0", "homedir": self.homedir, "via": "remote"})
        if method == "GET" and path == "/terminals":
            return self.send(req, 200, {"terminals": self.terminals})
        if method == "GET" and path.startswith("/terminals/") and path.endswith(("/buffer", "/stream")):
            target = unquote(path[len("/terminals/"):].rsplit("/", 1)[0])
            terminal = self.resolve(target)
            if terminal is None:
                return self.not_found(req, target)
            if path.endswith("/stream"):
                return self.stream(req)
            max_chars = int(parse_qs(parts.query).get("max_chars", ["40000"])[0])
            return self.send(req, 200, {"terminal": terminal, "buffer": BUFFER, "chars": len(BUFFER),
                                        "max_chars": max_chars})
        if method == "POST" and path == "/terminals/spawn":
            if self.spawn_reply:
                return self.send(req, *self.spawn_reply)
            sessions = [
                {**self.terminals[0], "id": f"17594000099{index:02d}-abcdef{index:06d}", "kind": body["kind"]}
                for index in range(body.get("count", 1))
            ]
            return self.send(req, 200, {"sessions": sessions})
        if method == "POST" and path in ("/terminals/write", "/terminals/input", "/terminals/kill"):
            target = body.get("terminal_id")
            terminal = self.resolve(target)
            if terminal is None:
                return self.not_found(req, target)
            key = "killed" if path.endswith("kill") else "written"
            return self.send(req, 200, {key: True, "terminal": terminal})
        if method == "POST" and path == "/workspaces/open":
            workspace = {"nativePath": body["project_dir"], "wslPath": None, "displayPath": body["project_dir"]}
            return self.send(req, 200, {"workspace": workspace, "selected": body.get("select")})
        return self.send(req, 404, {"error": f"Unknown control endpoint: {method} {path}"})

    def resolve(self, target: str) -> dict[str, Any] | None:
        for terminal in self.terminals:
            if terminal["id"] == target:
                return terminal
        kind, _, index = target.partition("#")
        same_kind = [terminal for terminal in self.terminals if terminal["kind"] == kind]
        position = int(index or 1) - 1
        return same_kind[position] if 0 <= position < len(same_kind) else None

    def not_found(self, req: BaseHTTPRequestHandler, target: str) -> None:
        self.send(req, 400, {"error": f"Error: Embedded terminal target not found: {target}"})

    @staticmethod
    def send(req: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        req.send_response(status)
        req.send_header("Content-Type", "application/json; charset=utf-8")
        req.send_header("Content-Length", str(len(data)))
        req.end_headers()
        req.wfile.write(data)

    @staticmethod
    def stream(req: BaseHTTPRequestHandler) -> None:
        """Chunked SSE like Node's: snapshot, a data event split mid-character and
        mid-CRLF across writes, a heartbeat, then exit."""
        req.send_response(200)
        req.send_header("Content-Type", "text/event-stream; charset=utf-8")
        req.send_header("Transfer-Encoding", "chunked")
        req.send_header("Connection", "close")
        req.end_headers()

        def chunk(data: bytes) -> None:
            req.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            req.wfile.flush()
            time.sleep(0.02)

        chunk(b": athena-control stream\n\n")
        snapshot = json.dumps({"epoch": 1, "throughSequence": 3, "data": SNAPSHOT})
        chunk(f"id: 1:3\nevent: snapshot\ndata: {snapshot}\n\n".encode())
        live = json.dumps({"epoch": 1, "fromSequence": 4, "sequence": 5, "data": LIVE}, ensure_ascii=False)
        event = f"id: 1:5\r\nevent: data\r\ndata: {live}\r\n\r\n".encode()
        split = event.index("é".encode()) + 1  # inside the two-byte "é"
        chunk(event[:split])
        chunk(event[split:-1])  # leaves the final "\n" of the closing CRLF for later
        chunk(event[-1:] + b": keep-alive\n\n")
        exit_payload = json.dumps({"exitCode": 0, "epoch": 1, "throughSequence": 5})
        chunk(f"event: exit\ndata: {exit_payload}\n\n".encode())
        req.wfile.write(b"0\r\n\r\n")
        req.wfile.flush()
        req.close_connection = True


def _status(surface_ip: str = "127.0.0.1") -> dict[str, Any]:
    def node(node_id: str, user: int, host: str, dns: str, os_name: str, online: bool, ips: list[str], **extra: Any):
        return {"ID": node_id, "UserID": user, "HostName": host, "DNSName": dns, "OS": os_name,
                "Online": online, "TailscaleIPs": ips, **extra}

    return {
        "BackendState": "Running",
        "Self": node("n0", 1, "omarchy", "omarchy.tail1234.ts.net.", "linux", True, ["100.64.0.1"]),
        "Peer": {
            # IPv6 listed first: the IPv4 address must still be preferred.
            "k1": node("n1", 1, "Surface-Pro", "surface.tail1234.ts.net.", "windows", True,
                       ["fd7a:115c:a1e0::2", surface_ip]),
            "k2": node("n2", 2, "work-laptop", "work-laptop.tail1234.ts.net.", "macOS", True, ["100.64.0.3"]),
            "k3": node("n3", 1, "nas", "nas.tail1234.ts.net.", "linux", True, ["100.64.0.4"], Tags=None),
            "k4": node("n4", 1, "old-desktop", "old-desktop.tail1234.ts.net.", "linux", False, ["100.64.0.5"]),
            "k5": node("n5", 1, "localhost", "iphone.tail1234.ts.net.", "iOS", True, ["100.64.0.6"]),
        },
        "User": {"1": {"LoginName": "alan@example.com"}, "2": {"LoginName": "bob@example.com"}},
    }


def _closed_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("ATHENA_REMOTE_TOKEN", "ATHENA_REMOTE_PORT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", "/home/localuser")
    monkeypatch.setenv("USERPROFILE", "/home/localuser")
    monkeypatch.setattr(remote, "tailscale_status", lambda: _status())


@pytest.fixture
def fake():
    host = FakeHost()
    yield host
    host.close()


def run(*argv: str) -> int:
    return cli_main.main(list(argv))


# --------------------------------------------------------------------------- #
# Machine + target resolution
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("spec", "url", "name", "label"),
    [
        ("surface", "http://127.0.0.1:47821", "surface", "surface"),
        ("SURFACE", "http://127.0.0.1:47821", "surface", "surface"),
        ("surface.tail1234.ts.net.", "http://127.0.0.1:47821", "surface", "surface"),
        ("Surface.Tail1234.ts.net", "http://127.0.0.1:47821", "surface", "surface"),
        ("surface-pro", "http://127.0.0.1:47821", "surface", "surface"),  # HostName
        ("fd7a:115c:a1e0::2", "http://127.0.0.1:47821", "surface", "surface"),  # IPv6 -> IPv4 URL
        ("100.64.0.3", "http://100.64.0.3:47821", "work-laptop", "work-laptop"),
        ("surface:9000", "http://127.0.0.1:9000", "surface", "surface:9000"),
        ("http://10.0.0.5:9999/", "http://10.0.0.5:9999", "10.0.0.5", "http://10.0.0.5:9999"),
        ("example-host:1234", "http://example-host:1234", "example-host", "example-host:1234"),
        ("mystery", "http://mystery:47821", "mystery", "mystery"),
    ],
)
def test_resolve_machine(spec: str, url: str, name: str, label: str) -> None:
    machine = remote.resolve_machine(spec, 47821, remote.parse_peers(_status()))
    assert (machine.url, machine.name, machine.label) == (url, name, label)


def test_resolve_machine_falls_back_to_hostname_without_tailscale(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(remote, "tailscale_status", lambda: None)
    machine = remote.resolve_machine("surface", 47821)
    assert machine.url == "http://surface:47821"
    assert machine.peer is None


def test_resolve_machine_prefers_unique_names_over_shared_hostnames() -> None:
    status = _status()
    status["Peer"]["k6"] = {**status["Peer"]["k1"], "ID": "n6", "DNSName": "surface-1.tail1234.ts.net.",
                            "TailscaleIPs": ["100.64.0.9"]}
    peers = remote.parse_peers(status)
    assert remote.resolve_machine("surface-1", 1, peers).url == "http://100.64.0.9:1"
    with pytest.raises(remote.RemoteError, match="matches several machines"):
        remote.resolve_machine("Surface-Pro", 1, peers)


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ("surface:claude", ("surface", "claude")),
        ("surface:codex#2", ("surface", "codex#2")),
        ("surface:47821:3f9c", ("surface:47821", "3f9c")),
        ("100.64.0.3:claude", ("100.64.0.3", "claude")),
        ("http://127.0.0.1:1234/claude%232", ("http://127.0.0.1:1234", "claude#2")),
    ],
)
def test_parse_target(target: str, expected: tuple[str, str]) -> None:
    assert remote.parse_target(target) == expected


@pytest.mark.parametrize("target", ["surface", "surface:", ":claude", "http://127.0.0.1:1234/"])
def test_parse_target_rejects_incomplete_targets(target: str) -> None:
    with pytest.raises(remote.RemoteError):
        remote.parse_target(target)


def test_tailscale_status_uses_json_even_when_cli_exits_nonzero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()  # drop the autouse fake
    calls: list[list[str]] = []

    def fake_run(cmd, **_kw):  # noqa: ANN001, ANN202
        calls.append(cmd)
        if cmd[0] == "tailscale":
            raise FileNotFoundError(cmd[0])
        return subprocess.CompletedProcess(cmd, 1, stdout='{"BackendState": "Stopped"}', stderr="")

    monkeypatch.setattr(remote, "_tailscale_commands", lambda: ["tailscale", "/opt/tailscale"])
    monkeypatch.setattr(remote.subprocess, "run", fake_run)
    assert remote.tailscale_status() == {"BackendState": "Stopped"}
    assert [cmd[0] for cmd in calls] == ["tailscale", "/opt/tailscale"]
    assert calls[-1][1:] == ["status", "--json"]

    monkeypatch.setattr(remote, "_tailscale_commands", lambda: ["tailscale"])
    assert remote.tailscale_status() is None


# --------------------------------------------------------------------------- #
# machines / ls
# --------------------------------------------------------------------------- #
@pytest.fixture
def tailnet(monkeypatch: pytest.MonkeyPatch):
    """surface = ready, work-laptop = needs token, nas = not answering."""
    ready, locked = FakeHost(), FakeHost(token="s3cret")
    ports = {"surface": ready.port, "work-laptop": locked.port, "nas": _closed_port()}
    probed: list[str] = []

    def peer_url(peer: remote.Peer, port: int) -> str:
        probed.append(peer.name)
        return f"http://127.0.0.1:{ports.get(peer.name, 9)}"

    monkeypatch.setattr(remote, "peer_url", peer_url)
    yield ready, locked, probed
    ready.close()
    locked.close()


def test_machines_classifies_each_desktop_peer(tailnet, capsys) -> None:
    assert run("remote", "machines") == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].split() == ["NAME", "STATUS", "OS", "ADDRESS", "DETAIL"]
    rows = {line.split()[0]: line for line in out[1:]}
    assert list(rows) == ["surface", "work-laptop", "nas", "old-desktop"]  # sorted by status
    assert "ready" in rows["surface"] and "Athena 0.3.0" in rows["surface"] and "127.0.0.1" in rows["surface"]
    assert "needs token" in rows["work-laptop"] and "not on your Tailscale account" in rows["work-laptop"]
    assert "not answering" in rows["nas"]
    assert "offline" in rows["old-desktop"]
    # Columns line up: every STATUS cell starts at the same offset.
    assert len({line.index(status) for line, status in zip(out[1:], ["ready", "needs", "not", "offline"])}) == 1


def test_machines_json_skips_self_phones_and_offline_probes(tailnet, capsys) -> None:
    _, _, probed = tailnet
    assert run("remote", "machines", "--json") == 0
    rows = json.loads(capsys.readouterr().out)
    by_name = {row["name"]: row for row in rows}
    assert set(by_name) == {"surface", "work-laptop", "nas", "old-desktop"}  # no omarchy (self), no iphone
    assert by_name["surface"]["status"] == "ready"
    assert by_name["surface"]["homedir"] == "/home/remote"
    assert by_name["surface"]["own_device"] is True
    assert by_name["work-laptop"]["status"] == "needs-token"
    assert by_name["work-laptop"]["own_device"] is False
    assert by_name["work-laptop"]["owner"] == "bob@example.com"
    assert by_name["nas"]["status"] == "not-answering"
    assert by_name["old-desktop"]["status"] == "offline"
    assert by_name["old-desktop"]["detail"] is None  # offline: listed, never probed
    assert "old-desktop" in probed and "iphone" not in probed and "omarchy" not in probed
    assert [seen.path for seen in tailnet[0].requests] == ["/machine"]


def test_machines_never_broadcasts_the_token(tailnet, capsys) -> None:
    # A token belongs to one machine; `machines` contacts every peer, so it must not send it.
    assert run("remote", "--token", "s3cret", "machines", "--json") == 0
    rows = {row["name"]: row for row in json.loads(capsys.readouterr().out)}
    assert rows["work-laptop"]["status"] == "needs-token"
    assert "athena remote ls work-laptop --token" in rows["work-laptop"]["detail"]
    ready, locked, _probed = tailnet
    for host in (ready, locked):
        assert all("Authorization" not in seen.headers for seen in host.requests)


def test_ls_one_machine_shows_running_terminals(fake, capsys) -> None:
    assert run("remote", "ls", "surface", "--port", str(fake.port)) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].split() == ["TARGET", "KIND", "STATUS", "TITLE", "WORKSPACE"]
    assert len(lines) == 3
    assert lines[1].split()[:3] == ["surface:3f9c2a1b", "claude", "running"]
    assert lines[1].endswith("/home/remote/src/app")
    assert lines[2].split()[:2] == ["surface:3f9d77aa", "codex"]
    assert lines[1].index("claude") == lines[0].index("KIND")


def test_ls_all_and_json(fake, capsys) -> None:
    assert run("remote", "ls", "surface", "--all", "--port", str(fake.port)) == 0
    assert "surface:c0ffee12" in capsys.readouterr().out

    assert run("remote", "ls", "surface", "--json", "--port", str(fake.port)) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [row["id"] for row in rows] == [CLAUDE_ID, CODEX_ID]
    assert rows[0]["machine"] == "surface"
    assert rows[0]["target"] == f"surface:{CLAUDE_ID}"
    assert rows[0]["short_target"] == "surface:3f9c2a1b"


def test_ls_without_machine_covers_ready_machines(tailnet, capsys) -> None:
    assert run("remote", "ls") == 0
    captured = capsys.readouterr()
    assert "surface:3f9c2a1b" in captured.out
    assert "note: not shown: work-laptop (needs token), nas (not answering)" in captured.err


def test_ls_with_url_machine_labels_targets_as_urls(fake, capsys) -> None:
    assert run("remote", "ls", fake.url) == 0
    assert f"{fake.url}/3f9c2a1b" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# spawn / open
# --------------------------------------------------------------------------- #
def test_spawn_posts_request_and_prints_targets(fake, capsys) -> None:
    code = run("remote", "spawn", "surface", "claude", "--workspace", "/srv/app", "--count", "2",
               "--task", "fix the failing test", "--title", "Fixer", "--port", str(fake.port))
    assert code == 0
    assert fake.bodies("/terminals/spawn") == [{
        "project_dir": "/srv/app", "kind": "claude", "count": 2, "task": "fix the failing test",
        "title": "Fixer", "open_workspace": True, "select_workspace": False,
    }]
    assert capsys.readouterr().out.splitlines() == [
        "surface:1759400009900-abcdef000000",
        "surface:1759400009901-abcdef000001",
    ]


def test_spawn_expands_quoted_tilde_with_remote_home(fake) -> None:
    assert run("remote", "spawn", "surface", "shell", "-w", "~/src/app", "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/spawn")[0]["project_dir"] == "/home/remote/src/app"
    assert run("remote", "spawn", "surface", "shell", "-w", "~", "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/spawn")[1]["project_dir"] == "/home/remote"


def test_spawn_expands_tilde_with_windows_home() -> None:
    assert remote._join_remote("C:\\Users\\alan", "src/app") == "C:\\Users\\alan\\src\\app"


def test_spawn_warns_about_locally_expanded_tilde(fake, capsys) -> None:
    assert run("remote", "spawn", "surface", "shell", "-w", "/home/localuser/src", "--port", str(fake.port)) == 0
    err = capsys.readouterr().err
    assert "under your LOCAL home (/home/localuser)" in err and "/home/remote" in err
    assert fake.bodies("/terminals/spawn")[0]["project_dir"] == "/home/localuser/src"  # warned, not rewritten


def test_spawn_not_installed_shows_install_command(fake, capsys) -> None:
    fake.spawn_reply = (409, {
        "error": "agent_not_installed", "agent": "codex",
        "message": "Codex (codex) is not installed or not on PATH.",
        "install_command": "npm install -g @openai/codex", "docs": "https://example.com/codex",
    })
    assert run("remote", "spawn", "surface", "codex", "-w", "/srv", "--port", str(fake.port)) == 1
    err = capsys.readouterr().err.strip()
    assert err == (
        "error: codex isn't installed on surface: Codex (codex) is not installed or not on PATH. "
        "Install it there with: npm install -g @openai/codex (docs: https://example.com/codex)"
    )


def test_spawn_memory_pressure_suggests_override(fake, capsys) -> None:
    fake.spawn_reply = (429, {"error": "Memory is critically low.", "retryable": True,
                              "override": "Resubmit with memory_override: true.", "admission": {}})
    assert run("remote", "spawn", "surface", "claude", "-w", "/srv", "--port", str(fake.port)) == 1
    err = capsys.readouterr().err
    assert "surface is short on memory: Memory is critically low." in err
    assert "--memory-override" in err

    fake.spawn_reply = None
    assert run("remote", "spawn", "surface", "claude", "-w", "/srv", "--memory-override",
               "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/spawn")[-1]["memory_override"] is True


def test_spawn_rejects_bad_count_without_a_request(fake, capsys) -> None:
    assert run("remote", "spawn", "surface", "claude", "-w", "/srv", "--count", "9", "--port", str(fake.port)) == 1
    assert "--count must be between 1 and 8" in capsys.readouterr().err
    assert fake.requests == []


def test_open_workspace(fake, capsys) -> None:
    assert run("remote", "open", "surface", "~/notes", "--port", str(fake.port)) == 0
    assert fake.bodies("/workspaces/open") == [{"project_dir": "/home/remote/notes", "select": False}]
    assert capsys.readouterr().out.strip() == "opened /home/remote/notes on surface"


# --------------------------------------------------------------------------- #
# say / keys / kill
# --------------------------------------------------------------------------- #
def test_say_joins_text_and_passes_handles_through(fake, capsys) -> None:
    assert run("remote", "say", "surface:claude", "yes,", "commit", "it", "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/write") == [{"terminal_id": "claude", "text": "yes, commit it"}]
    assert not any(seen.path == "/terminals" for seen in fake.requests)  # handles need no lookup
    assert capsys.readouterr().out.strip() == "sent to surface:3f9c2a1b (claude, Claude Code)"


def test_say_over_url_target(fake) -> None:
    assert run("remote", "say", f"{fake.url}/codex%231", "hi") == 0
    assert fake.bodies("/terminals/write") == [{"terminal_id": "codex#1", "text": "hi"}]


def test_keys_decodes_escapes_then_named_keys(fake) -> None:
    assert run("remote", "keys", "surface:claude", r"\e[A\x03\\a\tb\r\n", "--key", "enter", "--key", "DOWN",
               "--key", "ctrl-c", "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/input") == [
        {"terminal_id": "claude", "data": "\x1b[A\x03\\a\tb\r\n" + "\r" + "\x1b[B" + "\x03"}
    ]


def test_keys_only_named_keys(fake) -> None:
    assert run("remote", "keys", "surface:claude", "--key", "esc", "--key", "backspace",
               "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/input") == [{"terminal_id": "claude", "data": "\x1b\x7f"}]


def test_keys_needs_something_to_send_and_valid_escapes(fake, capsys) -> None:
    assert run("remote", "keys", "surface:claude", "--port", str(fake.port)) == 1
    assert "nothing to send" in capsys.readouterr().err
    assert run("remote", "keys", "surface:claude", r"\q", "--port", str(fake.port)) == 1
    assert "unsupported escape" in capsys.readouterr().err
    assert fake.requests == []


def test_kill_resolves_id_prefix(fake, capsys) -> None:
    assert run("remote", "kill", "surface:3f9c", "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/kill") == [{"terminal_id": CLAUDE_ID}]
    assert capsys.readouterr().out.strip() == "killed surface:3f9c2a1b (claude, Claude Code)"


def test_id_prefix_matches_full_id_start_too(fake) -> None:
    assert run("remote", "say", f"surface:{CODEX_ID[:15]}", "hi", "--port", str(fake.port)) == 0
    assert fake.bodies("/terminals/write") == [{"terminal_id": CODEX_ID, "text": "hi"}]


def test_id_prefix_ambiguous_lists_candidates(fake, capsys) -> None:
    # The timestamp half of an id is shared by terminals launched close together.
    assert run("remote", "kill", "surface:1759400000", "--port", str(fake.port)) == 1
    err = capsys.readouterr().err
    assert "'1759400000' matches 2 terminals on surface; use more characters:" in err
    assert "surface:3f9c2a1b (claude, Claude Code)" in err
    assert "surface:3f9d77aa (codex, Codex)" in err
    assert fake.bodies("/terminals/kill") == []


def test_short_strings_pass_through_to_the_host(fake, capsys) -> None:
    # Under 4 characters is not treated as an id prefix; the host decides.
    assert run("remote", "kill", "surface:3f9", "--port", str(fake.port)) == 1
    assert capsys.readouterr().err.strip() == "error: HTTP 400: Embedded terminal target not found: 3f9"
    assert fake.bodies("/terminals/kill") == [{"terminal_id": "3f9"}]


def test_id_prefix_without_match(fake, capsys) -> None:
    assert run("remote", "kill", "surface:beef", "--port", str(fake.port)) == 1
    assert "no terminal on surface matches 'beef'" in capsys.readouterr().err
    assert fake.bodies("/terminals/kill") == []


def test_full_id_passes_through_without_lookup(fake) -> None:
    assert run("remote", "kill", f"surface:{SHELL_ID}", "--port", str(fake.port)) == 0
    assert [seen.path for seen in fake.requests] == ["/terminals/kill"]


def test_host_errors_are_shown_without_error_prefix(fake, capsys) -> None:
    assert run("remote", "say", "surface:grok", "hi", "--port", str(fake.port)) == 1
    assert capsys.readouterr().err.strip() == "error: HTTP 400: Embedded terminal target not found: grok"


# --------------------------------------------------------------------------- #
# tail
# --------------------------------------------------------------------------- #
def test_tail_prints_buffer_as_is(fake, capsys) -> None:
    assert run("remote", "tail", "surface:claude", "--port", str(fake.port)) == 0
    assert capsys.readouterr().out == BUFFER
    buffer_requests = [seen for seen in fake.requests if seen.path.endswith("/buffer")]
    assert buffer_requests[0].query["max_chars"] == ["40000"]

    assert run("remote", "tail", "surface:claude", "--lines", "2", "--chars", "5000", "--port", str(fake.port)) == 0
    assert capsys.readouterr().out == "line2\r\nline3\r\n"
    assert fake.requests[-1].query["max_chars"] == ["5000"]


def test_tail_quotes_handles_in_the_path(fake, capsys) -> None:
    assert run("remote", "tail", "surface:codex#1", "--port", str(fake.port)) == 0
    assert capsys.readouterr().out == BUFFER


def test_tail_follow_streams_until_exit(fake, capsys) -> None:
    assert run("remote", "tail", "surface:claude", "-f", "--port", str(fake.port)) == 0
    captured = capsys.readouterr()
    assert captured.out == SNAPSHOT + LIVE
    assert captured.err.strip() == "[process exited: 0]"
    stream = [seen for seen in fake.requests if seen.path.endswith("/stream")][0]
    assert stream.query["format"] == ["json"]


def test_tail_follow_json_emits_events(fake, capsys) -> None:
    assert run("remote", "tail", "surface:claude", "--follow", "--json", "--port", str(fake.port)) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["snapshot", "data", "exit"]
    assert events[1]["data"] == LIVE


def test_sse_parser_handles_any_chunking() -> None:
    stream = (
        ": heartbeat\r\n\r\n"
        "event: snapshot\r\ndata: first\r\ndata: second\r\n\r\n"
        "data:no-space\rid: 7\r\r"
        "event: exit\ndata: {}\n\n"
        "event: partial\ndata: never finished\n"
    )
    for size in (1, 2, 3, 7, len(stream)):
        parser = remote.SSEParser()
        events = []
        for start in range(0, len(stream), size):
            events += parser.feed(stream[start : start + size])
        assert [(event.event, event.data) for event in events] == [
            ("snapshot", "first\nsecond"),
            ("message", "no-space"),
            ("exit", "{}"),
        ], size
        assert events[1].id == "7"


# --------------------------------------------------------------------------- #
# auth + connection errors
# --------------------------------------------------------------------------- #
def test_token_is_sent_as_bearer(capsys) -> None:
    host = FakeHost(token="s3cret")
    try:
        assert run("remote", "ls", "surface", "--port", str(host.port), "--token", "s3cret") == 0
        assert host.requests[-1].headers["Authorization"] == "Bearer s3cret"
        assert "Origin" not in host.requests[-1].headers  # the host refuses browser requests
    finally:
        host.close()


def test_token_from_environment(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    host = FakeHost(token="envtoken")
    monkeypatch.setenv("ATHENA_REMOTE_TOKEN", "envtoken")
    monkeypatch.setenv("ATHENA_REMOTE_PORT", str(host.port))
    try:
        assert run("remote", "ls", "surface") == 0
        assert host.requests[-1].headers["Authorization"] == "Bearer envtoken"
    finally:
        host.close()


def test_no_token_header_by_default(fake) -> None:
    assert run("remote", "ls", "surface", "--port", str(fake.port)) == 0
    assert "Authorization" not in fake.requests[-1].headers


@pytest.mark.parametrize("from_env", [False, True])
def test_token_is_not_sent_to_an_undiscovered_hostname(fake, monkeypatch, capsys, from_env) -> None:
    monkeypatch.setattr(remote, "load_peers", lambda: [])
    args = ["remote", "ls", f"127.0.0.1:{fake.port}"]
    if from_env:
        monkeypatch.setenv("ATHENA_REMOTE_TOKEN", "secret")
    else:
        args += ["--token", "secret"]
    assert run(*args) == 1
    assert "refusing to send" in capsys.readouterr().err
    assert fake.requests == [], "a DNS fallback must never receive the token"


def test_token_can_be_sent_to_an_explicit_url(fake, monkeypatch) -> None:
    monkeypatch.setattr(remote, "load_peers", lambda: [])
    monkeypatch.setenv("ATHENA_REMOTE_TOKEN", "secret")
    assert run("remote", "ls", fake.url) == 0
    assert fake.requests[-1].headers["Authorization"] == "Bearer secret"


def test_missing_token_message(capsys) -> None:
    host = FakeHost(token="s3cret")
    try:
        assert run("remote", "ls", "surface", "--port", str(host.port)) == 1
    finally:
        host.close()
    assert capsys.readouterr().err.strip() == (
        "error: surface needs its access token: pass --token or set ATHENA_REMOTE_TOKEN "
        "(Settings > System > Remote access > Copy token on that machine)."
    )


def test_wrong_token_message(capsys) -> None:
    host = FakeHost(token="s3cret")
    try:
        assert run("remote", "ls", "surface", "--port", str(host.port), "--token", "nope") == 1
    finally:
        host.close()
    assert "surface rejected the access token" in capsys.readouterr().err


def test_connection_refused_message(capsys) -> None:
    port = _closed_port()
    assert run("remote", "ls", "surface", "--port", str(port)) == 1
    err = capsys.readouterr().err
    assert err.strip() == (
        f"error: Athena isn't answering on surface (http://127.0.0.1:{port}). "
        "Is it running there with Settings > System > Remote access on?"
    )
    assert "athena serve" not in err  # no local-backend hint for remote errors


def test_tailscale_unavailable_for_discovery(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr(remote, "tailscale_status", lambda: None)
    assert run("remote", "machines") == 1
    assert "can't run `tailscale status`" in capsys.readouterr().err
