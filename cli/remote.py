"""`athena remote`: drive Athena terminals on your other machines.

Each Athena desktop can expose its Electron control API on its Tailscale
addresses (Settings > System > Remote access, port 47821 by default). These
commands talk to that API directly over HTTP -- not to the local FastAPI backend
the rest of the CLI uses -- with only the standard library, so they work on a
bare Python (for example over SSH from a phone) without httpx.

Requests from another device signed in to the same Tailscale account need no
token. Devices on other accounts need that machine's access token
(``--token`` / ``ATHENA_REMOTE_TOKEN``), sent as ``Authorization: Bearer``.

Addressing:
  MACHINE  a tailnet name (short name, HostName, or MagicDNS name), a Tailscale
           IP, ``host:port``, or a full ``http://host:port`` URL. Anything not
           found in ``tailscale status`` is used as a hostname as-is.
  TARGET   ``MACHINE:TERMINAL`` (``MACHINE:PORT:TERMINAL`` for an explicit
           port), or ``http://host:port/TERMINAL``. TERMINAL is a terminal id,
           a unique id prefix (as ``athena remote ls`` shows), or a handle the
           host resolves itself (``claude``, ``claude#2``).
"""

from __future__ import annotations

import argparse
import codecs
import http.client
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, unquote, urlencode, urlsplit

from . import __version__

DEFAULT_PORT = 47821
PROBE_TIMEOUT = 2.5
REQUEST_TIMEOUT = 15.0
# Spawning checks the agent CLI is installed and staggers multi-agent launches.
SPAWN_TIMEOUT = 120.0
# The host sends an SSE heartbeat every 15 s; three missed ones means it's gone.
STREAM_IDLE_TIMEOUT = 45.0
TAILSCALE_TIMEOUT = 10.0
DEFAULT_BUFFER_CHARS = 40_000
MAX_SPAWN_COUNT = 8

# Athena runs on desktops; phones and appliances on the tailnet are left out.
DESKTOP_OS = frozenset({"linux", "windows", "macos", "darwin"})
TERMINAL_KINDS = ("shell", "claude", "codex", "opencode", "athena", "grok", "hermes")
STATUS_ORDER = {"ready": 0, "needs-token": 1, "refused": 2, "error": 3, "not-answering": 4, "offline": 5}

NAMED_KEYS = {
    "enter": "\r",
    "esc": "\x1b",
    "tab": "\t",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "backspace": "\x7f",
}
_SIMPLE_ESCAPES = {"r": "\r", "n": "\n", "t": "\t", "e": "\x1b", "\\": "\\"}

TOKEN_HELP = "Settings > System > Remote access > Copy token on that machine"


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class RemoteError(Exception):
    """A failure whose message is complete and user-facing (printed as ``error: <msg>``)."""


class RemoteUnreachable(RemoteError):
    """Nothing answered: connection refused, timed out, or the host is unknown."""

    def __init__(self, message: str, *, timed_out: bool = False) -> None:
        super().__init__(message)
        self.timed_out = timed_out


class RemoteHTTPError(RemoteError):
    """The host answered with a non-2xx status."""

    def __init__(self, message: str, *, status: int, payload: Any, text: str) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload
        self.text = text


# --------------------------------------------------------------------------- #
# Tailscale discovery
# --------------------------------------------------------------------------- #
def _tailscale_commands() -> list[str]:
    if sys.platform == "win32":
        program_files = os.environ.get("ProgramFiles") or r"C:\Program Files"
        return ["tailscale", os.path.join(program_files, "Tailscale", "tailscale.exe")]
    if sys.platform == "darwin":
        return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
    return ["tailscale"]


def tailscale_status() -> dict[str, Any] | None:
    """``tailscale status --json``, or None when the Tailscale CLI is unavailable."""
    for command in _tailscale_commands():
        try:
            result = subprocess.run(
                [command, "status", "--json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=TAILSCALE_TIMEOUT,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        # A stopped backend exits non-zero but still prints usable JSON.
        try:
            data = json.loads(result.stdout)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return None


@dataclass
class Peer:
    """One device from ``tailscale status``."""

    name: str
    host_name: str
    dns_name: str
    os: str
    online: bool
    ips: list[str]
    user_id: Any = None
    tags: list[str] = field(default_factory=list)
    owner: str | None = None
    is_self: bool = False

    @property
    def address(self) -> str | None:
        """IPv4 Tailscale address first; it is what the remote listener binds."""
        for ip in self.ips:
            if _is_ipv4(ip):
                return ip
        return self.ips[0] if self.ips else (self.dns_name or None)

    @property
    def is_desktop(self) -> bool:
        return self.os.lower() in DESKTOP_OS


def _is_ipv4(value: str) -> bool:
    try:
        return isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address)
    except ValueError:
        return False


def _parse_peer(record: dict[str, Any], users: dict[str, Any], *, is_self: bool = False) -> Peer:
    dns_name = str(record.get("DNSName") or "").rstrip(".")
    host_name = str(record.get("HostName") or "")
    ips = [ip for ip in (record.get("TailscaleIPs") or []) if isinstance(ip, str)]
    name = dns_name.split(".")[0] if dns_name else (host_name or (ips[0] if ips else "unknown"))
    user_id = record.get("UserID")
    user = users.get(str(user_id)) if isinstance(users, dict) else None
    owner = user.get("LoginName") if isinstance(user, dict) else None
    return Peer(
        name=name,
        host_name=host_name,
        dns_name=dns_name,
        os=str(record.get("OS") or ""),
        online=bool(record.get("Online")),
        ips=ips,
        user_id=user_id,
        tags=[str(tag) for tag in (record.get("Tags") or [])],
        owner=owner,
        is_self=is_self,
    )


def parse_peers(status: dict[str, Any]) -> list[Peer]:
    """Self (flagged ``is_self``) plus every peer, in Tailscale's order."""
    users = status.get("User") or {}
    peers: list[Peer] = []
    self_record = status.get("Self")
    if isinstance(self_record, dict):
        me = _parse_peer(self_record, users, is_self=True)
        if not me.ips:
            me.ips = [ip for ip in (status.get("TailscaleIPs") or []) if isinstance(ip, str)]
        peers.append(me)
    for record in (status.get("Peer") or {}).values():
        if isinstance(record, dict):
            peers.append(_parse_peer(record, users))
    return peers


def load_peers() -> list[Peer] | None:
    status = tailscale_status()
    return parse_peers(status) if status else None


def _require_tailscale() -> dict[str, Any]:
    status = tailscale_status()
    if status is None:
        raise RemoteError(
            "can't run `tailscale status`: is Tailscale installed and on PATH? "
            f"You can still address a machine directly, e.g. `athena remote ls http://HOST:{DEFAULT_PORT}`."
        )
    state = str(status.get("BackendState") or "")
    if state and state != "Running":
        raise RemoteError(f"Tailscale is {state} on this machine; connect it (e.g. `tailscale up`) and try again.")
    return status


def _own_device(peer: Peer, me: Peer | None) -> bool:
    return bool(
        me
        and me.user_id is not None
        and peer.user_id == me.user_id
        and not peer.tags
        and not me.tags
    )


# --------------------------------------------------------------------------- #
# Machine + target resolution
# --------------------------------------------------------------------------- #
@dataclass
class Machine:
    """Where one Athena's control API lives, and how to label it back to the user."""

    name: str
    url: str
    label: str
    peer: Peer | None = None
    url_form: bool = False

    def target(self, terminal: str) -> str:
        return f"{self.label}/{terminal}" if self.url_form else f"{self.label}:{terminal}"


def _http_url(host: str, port: int) -> str:
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}"


def peer_url(peer: Peer, port: int) -> str:
    """Control API base URL for a tailnet peer (its IPv4 address when it has one)."""
    return _http_url(peer.address or peer.name, port)


def _match_peer(host: str, peers: list[Peer]) -> Peer | None:
    key = host.strip().lower().rstrip(".")
    # Short names, MagicDNS names, and addresses are unique on a tailnet.
    for peer in peers:
        if key in (peer.name.lower(), peer.dns_name.lower()) or key in (ip.lower() for ip in peer.ips):
            return peer
    # HostName is what the OS calls itself, and two devices can share one.
    by_host = [peer for peer in peers if peer.host_name.lower() == key]
    if len(by_host) > 1:
        names = ", ".join(peer.name for peer in by_host)
        raise RemoteError(f"{host!r} matches several machines ({names}); use one of those names.")
    return by_host[0] if by_host else None


def resolve_machine(spec: str, port: int, peers: list[Peer] | None = None) -> Machine:
    """Turn a MACHINE argument into a control API URL (see the module docstring).

    ``peers`` defaults to a fresh ``tailscale status``; when Tailscale is
    unavailable or nothing matches, MACHINE is used as a hostname so MagicDNS
    (or any other resolver) can still find it.
    """
    raw = spec.strip()
    if not raw:
        raise RemoteError("machine name is empty.")
    if re.match(r"^https?://", raw, re.IGNORECASE):
        parts = urlsplit(raw)
        try:
            parts.port  # noqa: B018 - validates the port
        except ValueError:
            raise RemoteError(f"not a valid machine URL: {spec!r}") from None
        if not parts.hostname:
            raise RemoteError(f"not a valid machine URL: {spec!r}")
        base = f"{parts.scheme.lower()}://{parts.netloc}"
        return Machine(name=parts.hostname, url=base, label=base, url_form=True)

    host, explicit_port = raw, None
    host_port = re.fullmatch(r"([^:\s]+):(\d{1,5})", raw)
    if host_port:
        try:
            host, explicit_port = host_port.group(1), _port_type(host_port.group(2))
        except argparse.ArgumentTypeError as exc:
            raise RemoteError(f"{spec!r}: {exc}") from None
    use_port = explicit_port or port

    if peers is None:
        peers = load_peers()
    peer = _match_peer(host, peers or [])
    if peer is not None:
        label = peer.name if explicit_port is None else f"{peer.name}:{explicit_port}"
        return Machine(name=peer.name, url=peer_url(peer, use_port), label=label, peer=peer)
    return Machine(name=host, url=_http_url(host, use_port), label=raw)


def parse_target(target: str) -> tuple[str, str]:
    """Split TARGET into (MACHINE, TERMINAL).

    ``machine:terminal`` splits on the first ``:`` (machine names cannot contain
    one); ``machine:port:terminal`` keeps the port with the machine; a URL must
    be ``http://host:port/TERMINAL``.
    """
    raw = target.strip()
    if re.match(r"^https?://", raw, re.IGNORECASE):
        parts = urlsplit(raw)
        terminal = unquote(parts.path.strip("/"))
        if not parts.hostname or not terminal or "/" in terminal:
            raise RemoteError(f"a URL TARGET must look like http://HOST:PORT/TERMINAL, got {target!r}.")
        return f"{parts.scheme.lower()}://{parts.netloc}", terminal
    machine, sep, terminal = raw.partition(":")
    if not sep or not machine or not terminal:
        raise RemoteError(
            f"TARGET must be MACHINE:TERMINAL (e.g. omarchy:claude or omarchy:3f9c2a1b), got {target!r}."
        )
    with_port = re.fullmatch(r"(\d{1,5}):(.+)", terminal)
    if with_port:
        return f"{machine}:{with_port.group(1)}", with_port.group(2)
    return machine, terminal


_ID_SUFFIX = re.compile(r"^\d+-([0-9a-f]+)$", re.IGNORECASE)
_FULL_ID = re.compile(r"^\d{10,}-[0-9a-f]{6,}$", re.IGNORECASE)
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_ID_PREFIX = re.compile(r"^[0-9a-f-]{4,}$", re.IGNORECASE)


def _id_suffix(terminal_id: str) -> str:
    match = _ID_SUFFIX.match(terminal_id)
    return match.group(1) if match else ""


def short_id(terminal_id: str) -> str:
    """Display id. Athena ids are ``<epoch-ms>-<random hex>``; the timestamp half is
    shared by everything launched in the same minute or so, so use the random half."""
    return (_id_suffix(terminal_id) or terminal_id)[:8]


def _id_matches(session: dict[str, Any], prefix: str) -> bool:
    terminal_id = str(session.get("id") or "").lower()
    needle = prefix.lower()
    return terminal_id.startswith(needle) or _id_suffix(terminal_id).startswith(needle)


def resolve_terminal(host: RemoteHost, terminal: str) -> str:
    """Resolve TERMINAL to what the host should receive.

    Handles (``claude``, ``codex#2``) and full ids pass straight through. Short
    hex ids are matched as prefixes against the host's terminals; anything else
    is passed through for the host to resolve (or reject) itself.
    """
    value = terminal.strip()
    if not value:
        raise RemoteError("terminal is empty.")
    if "#" in value or value.lower() in TERMINAL_KINDS or _FULL_ID.match(value) or _UUID.match(value):
        return value
    if not _ID_PREFIX.match(value):
        return value
    sessions = host.terminals()
    for session in sessions:
        if value in (session.get("id"), session.get("providerSessionId")):
            return str(session["id"])
    matches = [session for session in sessions if _id_matches(session, value)]
    if len(matches) == 1:
        return str(matches[0]["id"])
    machine = host.machine
    if not matches:
        raise RemoteError(
            f"no terminal on {machine.name} matches {value!r}; "
            f"`athena remote ls {machine.label} --all` lists them."
        )
    lines = [f"{value!r} matches {len(matches)} terminals on {machine.name}; use more characters:"]
    lines += [f"  {_describe(machine, session)}" for session in matches]
    raise RemoteError("\n".join(lines))


def _describe(machine: Machine, session: dict[str, Any]) -> str:
    target = machine.target(short_id(str(session.get("id") or "")))
    details = [str(session.get("kind") or "?")]
    title = _clean(session.get("title"))
    if title:
        details.append(title)
    return f"{target} ({', '.join(details)})"


def _clean(value: Any, limit: int | None = None) -> str:
    text = " ".join(str(value or "").split())
    if limit and len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _decode_body(raw: bytes) -> Any:
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _error_text(payload: Any) -> str:
    if isinstance(payload, dict):
        value = payload.get("error") or payload.get("message") or payload.get("detail") or ""
    else:
        value = payload or ""
    text = " ".join(str(value).split())
    # The host reports thrown errors as String(error), i.e. "Error: ...".
    if text.startswith("Error: "):
        text = text[len("Error: "):]
    return text[:500]


@dataclass
class SSEEvent:
    event: str
    data: str
    id: str | None = None


_LINE_END = re.compile(r"\r\n|\r|\n")


class SSEParser:
    """Incremental Server-Sent Events parser: feed it text as it arrives.

    Handles events split across chunks, ``\\r\\n`` / ``\\r`` / ``\\n`` line ends,
    comment (heartbeat) lines, and multi-line ``data:`` fields.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._event = ""
        self._data: list[str] = []
        self.last_id: str | None = None

    def feed(self, text: str) -> list[SSEEvent]:
        buffer = self._buffer + text
        events: list[SSEEvent] = []
        pos = 0
        while True:
            match = _LINE_END.search(buffer, pos)
            # A trailing "\r" may be the first half of a "\r\n" still in flight.
            if match is None or (match.group() == "\r" and match.end() == len(buffer)):
                break
            event = self._line(buffer[pos : match.start()])
            pos = match.end()
            if event is not None:
                events.append(event)
        self._buffer = buffer[pos:]
        return events

    def _line(self, line: str) -> SSEEvent | None:
        if not line:
            event = SSEEvent(self._event or "message", "\n".join(self._data), self.last_id) if self._data else None
            self._event, self._data = "", []
            return event
        if line.startswith(":"):
            return None
        name, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        elif name == "id" and "\0" not in value:
            self.last_id = value
        return None


class RemoteHost:
    """One machine's Electron control API, over plain ``http.client``."""

    def __init__(self, machine: Machine, token: str | None = None, *, timeout: float = REQUEST_TIMEOUT) -> None:
        self.machine = machine
        self.token = token
        self.timeout = timeout
        parts = urlsplit(machine.url)
        self._https = parts.scheme == "https"
        self._host = parts.hostname or machine.name
        self._port = parts.port or (443 if self._https else 80)
        self._prefix = parts.path.rstrip("/")
        self._info: dict[str, Any] | None = None

    # -- plumbing ----------------------------------------------------------- #
    def _open(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        timeout: float,
        read_timeout: float | None = None,
        accept: str = "application/json",
    ) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        connection_class = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        conn = connection_class(self._host, self._port, timeout=timeout)
        headers = {"Accept": accept, "User-Agent": f"athena-cli/{__version__}"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            conn.connect()
            if read_timeout is not None and conn.sock is not None:
                conn.sock.settimeout(read_timeout)
            conn.request(method, self._prefix + path, body=data, headers=headers)
            return conn, conn.getresponse()
        except socket.gaierror as exc:
            conn.close()
            raise RemoteUnreachable(
                f"can't find {self.machine.name}: it isn't in `tailscale status` and its name doesn't resolve. "
                "`athena remote machines` lists your machines."
            ) from exc
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            raise self._unreachable(exc) from exc

    def _unreachable(self, exc: BaseException) -> RemoteUnreachable:
        return RemoteUnreachable(
            f"Athena isn't answering on {self.machine.name} ({self.machine.url}). "
            "Is it running there with Settings > System > Remote access on?",
            timed_out=isinstance(exc, TimeoutError),
        )

    def _http_error(self, status: int, payload: Any) -> RemoteHTTPError:
        text = _error_text(payload) or http.client.responses.get(status, "")
        name = self.machine.name
        if status == 401:
            if self.token:
                message = f"{name} rejected the access token: check --token / ATHENA_REMOTE_TOKEN ({TOKEN_HELP})."
            else:
                message = f"{name} needs its access token: pass --token or set ATHENA_REMOTE_TOKEN ({TOKEN_HELP})."
        elif status == 403:
            message = f"{name} refused the request: {text}"
        else:
            message = f"HTTP {status}: {text}"
        return RemoteHTTPError(message, status=status, payload=payload, text=text)

    def request(self, method: str, path: str, body: Any = None, *, timeout: float | None = None) -> Any:
        conn, response = self._open(method, path, body, timeout=timeout or self.timeout)
        try:
            raw = response.read()
        except (OSError, http.client.HTTPException) as exc:
            raise self._unreachable(exc) from exc
        finally:
            conn.close()
        payload = _decode_body(raw)
        if not 200 <= response.status < 300:
            raise self._http_error(response.status, payload)
        return payload

    def get(self, path: str, *, timeout: float | None = None, **params: Any) -> Any:
        query = {key: value for key, value in params.items() if value is not None}
        if query:
            path = f"{path}?{urlencode(query)}"
        return self.request("GET", path, timeout=timeout)

    def post(self, path: str, body: dict[str, Any], *, timeout: float | None = None) -> Any:
        return self.request("POST", path, body, timeout=timeout)

    def stream(self, path: str, *, idle_timeout: float = STREAM_IDLE_TIMEOUT) -> Iterator[SSEEvent]:
        """Yield SSE events from ``path`` until the host ends the stream."""
        conn, response = self._open(
            "GET", path, timeout=self.timeout, read_timeout=idle_timeout, accept="text/event-stream"
        )
        name = self.machine.name
        try:
            if not 200 <= response.status < 300:
                raise self._http_error(response.status, _decode_body(response.read()))
            parser = SSEParser()
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            while True:
                try:
                    chunk = response.read1(65536)
                except TimeoutError:
                    raise RemoteError(
                        f"lost the stream from {name}: nothing received for {int(idle_timeout)} s."
                    ) from None
                except (OSError, http.client.HTTPException) as exc:
                    raise RemoteError(f"lost the stream from {name}: {exc}") from None
                if not chunk:
                    break
                yield from parser.feed(decoder.decode(chunk))
            # An event without its closing blank line is incomplete; drop it.
            parser.feed(decoder.decode(b"", final=True))
        finally:
            conn.close()

    # -- endpoints ---------------------------------------------------------- #
    def machine_info(self) -> dict[str, Any]:
        if self._info is None:
            payload = self.get("/machine")
            self._info = payload if isinstance(payload, dict) else {}
        return self._info

    def terminals(self, *, timeout: float | None = None) -> list[dict[str, Any]]:
        payload = self.get("/terminals", timeout=timeout)
        terminals = payload.get("terminals") if isinstance(payload, dict) else None
        return [item for item in terminals or [] if isinstance(item, dict)]


def _probe(host: RemoteHost, path: str) -> tuple[str, Any]:
    """(status, payload-or-error) for one machine, never raising a RemoteError."""
    try:
        return "ready", host.get(path)
    except RemoteHTTPError as exc:
        if exc.status == 401:
            return "needs-token", exc
        if exc.status in (403, 429):
            return "refused", exc
        return "error", exc
    except RemoteError as exc:
        return "not-answering", exc


def _parallel(fn, items: list[Any]) -> list[Any]:  # noqa: ANN001 - small map helper
    if not items:
        return []
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=min(16, len(items))) as pool:
        return list(pool.map(fn, items))


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _port_type(value: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError(f"not a port number: {value!r}") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError(f"port must be 1-65535, got {port}")
    return port


def _port(args: argparse.Namespace) -> int:
    port = getattr(args, "port", None)
    if port is None:
        env = os.environ.get("ATHENA_REMOTE_PORT", "").strip()
        if env:
            try:
                port = _port_type(env)
            except argparse.ArgumentTypeError:
                raise RemoteError(f"ATHENA_REMOTE_PORT is not a valid port: {env!r}") from None
    return port or DEFAULT_PORT


def _token(args: argparse.Namespace) -> str | None:
    token = getattr(args, "token", None)
    if token is None:
        token = os.environ.get("ATHENA_REMOTE_TOKEN")
    return (token or "").strip() or None


def _host(args: argparse.Namespace, spec: str) -> RemoteHost:
    return RemoteHost(resolve_machine(spec, _port(args)), _token(args))


def _target(args: argparse.Namespace) -> tuple[RemoteHost, str]:
    machine, terminal = parse_target(args.target)
    host = _host(args, machine)
    return host, resolve_terminal(host, terminal)


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, default=str))


def _table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def line(cells: list[str]) -> str:
        return "  ".join(cell.ljust(widths[index]) for index, cell in enumerate(cells)).rstrip()

    return "\n".join([line(headers), *(line(row) for row in rows)])


def _write_raw(text: str) -> None:
    if not text:
        return
    try:
        sys.stdout.write(text)
    except UnicodeEncodeError:
        encoding = sys.stdout.encoding or "utf-8"
        sys.stdout.write(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))
    sys.stdout.flush()


def _last_lines(text: str, lines: int | None) -> str:
    if not lines or lines <= 0:
        return text
    return "".join(text.splitlines(keepends=True)[-lines:])


def decode_escapes(text: str) -> str:
    r"""Expand ``\r \n \t \e \xHH \\`` in a ``keys`` DATA argument."""
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        nxt = text[index + 1 : index + 2]
        hex_digits = text[index + 2 : index + 4]
        if nxt and nxt in _SIMPLE_ESCAPES:
            out.append(_SIMPLE_ESCAPES[nxt])
            index += 2
        elif nxt == "x" and re.fullmatch(r"[0-9a-fA-F]{2}", hex_digits):
            out.append(chr(int(hex_digits, 16)))
            index += 4
        else:
            bad = text[index : index + 2]
            raise RemoteError(
                f"unsupported escape {bad!r} in DATA; use \\r \\n \\t \\e \\xHH or \\\\ (or --key NAME)."
            )
    return "".join(out)


def _join_remote(home: str, rest: str) -> str:
    windows = bool(re.match(r"^[A-Za-z]:", home)) or ("\\" in home and "/" not in home)
    sep = "\\" if windows else "/"
    if windows:
        rest = rest.replace("/", "\\")
    rest = rest.strip(sep)
    return home.rstrip(sep) + sep + rest if rest else home


def _under(path: str, home: str) -> bool:
    home = home.rstrip("/\\")
    if not home:
        return False
    return path == home or path.startswith(home + "/") or path.startswith(home + "\\")


def remote_path(host: RemoteHost, path: str) -> str:
    """A path on ``host``: a literal leading ``~`` means the remote home.

    An unquoted ``~`` was already expanded by the local shell, so a path under
    the local home that is not under the remote one gets a warning.
    """
    raw = path.strip()
    name = host.machine.name
    if raw == "~" or raw.startswith(("~/", "~\\")):
        home = str(host.machine_info().get("homedir") or "")
        if not home:
            raise RemoteError(f"{name} didn't report its home directory; pass an absolute path.")
        return _join_remote(home, raw[2:])
    local_home = os.path.expanduser("~")
    if local_home not in ("~", "/") and _under(raw, local_home):
        remote_home = str(host.machine_info().get("homedir") or "")
        if remote_home and not _under(raw, remote_home):
            print(
                f"warning: {raw} is under your LOCAL home ({local_home}), but {name}'s home is {remote_home}. "
                "If your shell expanded ~, quote it instead ('~/...') to mean the remote home.",
                file=sys.stderr,
            )
    return raw


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def _machine_rows(status: dict[str, Any], port: int, token: str | None) -> list[dict[str, Any]]:
    peers = parse_peers(status)
    me = next((peer for peer in peers if peer.is_self), None)
    others = [peer for peer in peers if not peer.is_self and peer.is_desktop]

    def check(peer: Peer) -> dict[str, Any]:
        own = _own_device(peer, me)
        url = peer_url(peer, port) if peer.address else None
        row: dict[str, Any] = {
            "name": peer.name,
            "dns_name": peer.dns_name,
            "host_name": peer.host_name,
            "os": peer.os,
            "online": peer.online,
            "address": peer.address,
            "url": url,
            "owner": peer.owner,
            "own_device": own,
            "status": "offline",
            "detail": None,
            "version": None,
            "platform": None,
            "homedir": None,
        }
        if not peer.online or not url:
            return row
        host = RemoteHost(Machine(peer.name, url, peer.name, peer), token, timeout=PROBE_TIMEOUT)
        status_name, result = _probe(host, "/machine")
        row["status"] = status_name
        if status_name == "ready":
            info = result if isinstance(result, dict) else {}
            for key in ("version", "platform", "homedir"):
                row[key] = info.get(key)
            row["detail"] = f"Athena {info['version']}" if info.get("version") else "Athena"
        elif status_name == "needs-token":
            if token:
                row["detail"] = "token rejected; check --token"
            elif own:
                row["detail"] = f"trust-own-devices is off there; name it with --token, e.g. `athena remote ls {peer.name} --token ...`"
            else:
                row["detail"] = f"not on your Tailscale account; name it with --token, e.g. `athena remote ls {peer.name} --token ...`"
        elif status_name == "not-answering":
            timed_out = getattr(result, "timed_out", False)
            row["detail"] = "no answer (timed out)" if timed_out else "Athena closed or remote access off"
        else:
            row["detail"] = getattr(result, "text", None) or str(result)
        return row

    rows = _parallel(check, others)
    rows.sort(key=lambda row: (STATUS_ORDER.get(row["status"], 9), row["name"].lower()))
    return rows


def cmd_remote_machines(args: argparse.Namespace) -> int:
    # A token belongs to one machine: never hand it to every peer on the tailnet.
    rows = _machine_rows(_require_tailscale(), _port(args), None)
    if args.json:
        _print_json(rows)
        return 0
    if not rows:
        print("No other computers on your tailnet (phones and tablets are not listed).")
        return 0
    print(_table(
        ["NAME", "STATUS", "OS", "ADDRESS", "DETAIL"],
        [
            [row["name"], row["status"].replace("-", " "), row["os"], row["address"] or "", row["detail"] or ""]
            for row in rows
        ],
    ))
    return 0


def cmd_remote_ls(args: argparse.Namespace) -> int:
    groups: list[tuple[Machine, list[dict[str, Any]]]] = []
    if args.machine:
        host = _host(args, args.machine)
        groups.append((host.machine, host.terminals()))
    else:
        # A token belongs to one machine: a bare `ls` contacts every peer, so it sends none.
        port, token = _port(args), None
        peers = [
            peer
            for peer in parse_peers(_require_tailscale())
            if not peer.is_self and peer.is_desktop and peer.online and peer.address
        ]
        if not peers:
            raise RemoteError("none of your other computers is online on Tailscale.")
        hosts = [
            RemoteHost(Machine(peer.name, peer_url(peer, port), peer.name, peer), token, timeout=PROBE_TIMEOUT * 2)
            for peer in peers
        ]
        skipped: list[str] = []
        for host, (status_name, result) in zip(hosts, _parallel(lambda h: _probe(h, "/terminals"), hosts)):
            if status_name == "ready":
                terminals = result.get("terminals") if isinstance(result, dict) else None
                groups.append((host.machine, [item for item in terminals or [] if isinstance(item, dict)]))
            else:
                skipped.append(f"{host.machine.name} ({status_name.replace('-', ' ')})")
        if skipped:
            print(f"note: not shown: {', '.join(skipped)}", file=sys.stderr)
        if not groups:
            raise RemoteError("no machine answered; `athena remote machines` shows why.")

    rows: list[tuple[Machine, dict[str, Any]]] = [
        (machine, session)
        for machine, sessions in groups
        for session in sorted(sessions, key=lambda item: str(item.get("createdAt") or ""))
        if args.all or session.get("status") == "running"
    ]
    if args.json:
        _print_json([
            {
                **session,
                "machine": machine.name,
                "url": machine.url,
                "target": machine.target(str(session.get("id"))),
                "short_target": machine.target(short_id(str(session.get("id") or ""))),
            }
            for machine, session in rows
        ])
        return 0
    if not rows:
        names = ", ".join(machine.name for machine, _ in groups)
        print(f"No {'' if args.all else 'running '}terminals on {names}.")
        return 0
    print(_table(
        ["TARGET", "KIND", "STATUS", "TITLE", "WORKSPACE"],
        [
            [
                machine.target(short_id(str(session.get("id") or ""))),
                str(session.get("kind") or ""),
                str(session.get("status") or ""),
                _clean(session.get("title"), 40),
                str(session.get("workspace") or ""),
            ]
            for machine, session in rows
        ],
    ))
    return 0


def _spawn_error(host: RemoteHost, exc: RemoteHTTPError, kind: str) -> RemoteError:
    payload = exc.payload if isinstance(exc.payload, dict) else {}
    name = host.machine.name
    if exc.status == 409 and payload.get("error") == "agent_not_installed":
        message = _error_text({"error": payload.get("message")}) or f"{kind} is not installed."
        text = f"{payload.get('agent') or kind} isn't installed on {name}: {message}"
        if payload.get("install_command"):
            text += f" Install it there with: {payload['install_command']}"
        if payload.get("docs"):
            text += f" (docs: {payload['docs']})"
        return RemoteError(text)
    if exc.status == 429 and ("override" in payload or "admission" in payload):
        return RemoteError(
            f"{name} is short on memory: {exc.text} Re-run with --memory-override to launch anyway."
        )
    return exc


def cmd_remote_spawn(args: argparse.Namespace) -> int:
    if not 1 <= args.count <= MAX_SPAWN_COUNT:
        raise RemoteError(f"--count must be between 1 and {MAX_SPAWN_COUNT}.")
    host = _host(args, args.machine)
    body: dict[str, Any] = {
        "project_dir": remote_path(host, args.workspace),
        "kind": args.kind,
        "count": args.count,
        "open_workspace": True,
        "select_workspace": False,
    }
    if args.task:
        body["task"] = args.task
    if args.title:
        body["title"] = args.title
    if args.memory_override:
        body["memory_override"] = True
    try:
        payload = host.post("/terminals/spawn", body, timeout=SPAWN_TIMEOUT)
    except RemoteHTTPError as exc:
        # A partial multi-agent launch still started some panes: say which.
        started = exc.payload.get("sessions") if isinstance(exc.payload, dict) else None
        for session in started or []:
            if isinstance(session, dict) and session.get("id"):
                print(host.machine.target(str(session["id"])))
        raise _spawn_error(host, exc, args.kind) from None
    sessions = [item for item in (payload.get("sessions") or []) if isinstance(item, dict)]
    targets = [host.machine.target(str(session.get("id"))) for session in sessions]
    if args.json:
        _print_json({"machine": host.machine.name, "url": host.machine.url, "targets": targets, **payload})
        return 0
    for target in targets:
        print(target)
    return 0


def cmd_remote_open(args: argparse.Namespace) -> int:
    host = _host(args, args.machine)
    payload = host.post(
        "/workspaces/open", {"project_dir": remote_path(host, args.path), "select": bool(args.select)}
    )
    if args.json:
        _print_json(payload)
        return 0
    workspace = payload.get("workspace") if isinstance(payload, dict) else None
    shown = (workspace or {}).get("displayPath") or (workspace or {}).get("nativePath") or args.path
    print(f"opened {shown} on {host.machine.name}")
    return 0


def cmd_remote_tail(args: argparse.Namespace) -> int:
    host, target = _target(args)
    encoded = quote(target, safe="")
    if not args.follow:
        payload = host.get(f"/terminals/{encoded}/buffer", max_chars=args.chars)
        if args.json:
            _print_json(payload)
            return 0
        _write_raw(_last_lines(str((payload or {}).get("buffer") or ""), args.lines))
        return 0

    path = f"/terminals/{encoded}/stream?{urlencode({'format': 'json', 'max_chars': args.chars})}"
    first_snapshot = True
    try:
        for event in host.stream(path):
            if event.event not in ("snapshot", "data", "exit"):
                continue
            try:
                payload = json.loads(event.data) if event.data else {}
            except ValueError:
                continue
            if not isinstance(payload, dict):
                continue
            if args.json:
                print(json.dumps({"event": event.event, **payload}), flush=True)
            elif event.event == "snapshot":
                text = str(payload.get("data") or "")
                if first_snapshot:
                    text = _last_lines(text, args.lines)
                else:
                    # The host resets a consumer that fell too far behind.
                    print("\n[athena: output skipped; replaying the screen]", file=sys.stderr)
                first_snapshot = False
                _write_raw(text)
            elif event.event == "data":
                _write_raw(str(payload.get("data") or ""))
            if event.event == "exit":
                sys.stdout.flush()
                if not args.json:
                    code = payload.get("exitCode")
                    print(f"[process exited: {code if code is not None else '?'}]", file=sys.stderr)
                return 0
    except KeyboardInterrupt:
        sys.stdout.flush()
        return 130
    sys.stdout.flush()
    print(f"[stream from {host.machine.name} closed]", file=sys.stderr)
    return 1


def _report(args: argparse.Namespace, host: RemoteHost, payload: Any, verb: str) -> int:
    if args.json:
        _print_json(payload)
        return 0
    session = payload.get("terminal") if isinstance(payload, dict) else None
    print(f"{verb} {_describe(host.machine, session) if isinstance(session, dict) else host.machine.name}")
    return 0


def cmd_remote_say(args: argparse.Namespace) -> int:
    text = " ".join(args.text)
    if not text.strip():
        raise RemoteError("nothing to say.")
    host, target = _target(args)
    return _report(args, host, host.post("/terminals/write", {"terminal_id": target, "text": text}), "sent to")


def cmd_remote_keys(args: argparse.Namespace) -> int:
    data = decode_escapes(args.data) if args.data else ""
    data += "".join(NAMED_KEYS[key] for key in args.key or [])
    if not data:
        raise RemoteError("nothing to send: give DATA and/or --key (e.g. --key enter).")
    host, target = _target(args)
    return _report(args, host, host.post("/terminals/input", {"terminal_id": target, "data": data}), "sent keys to")


def cmd_remote_kill(args: argparse.Namespace) -> int:
    host, target = _target(args)
    return _report(args, host, host.post("/terminals/kill", {"terminal_id": target}), "killed")


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #
_EPILOG = """\
MACHINE is a tailnet name or IP (see `athena remote machines`), host:port, or http://host:port.
TARGET is MACHINE:TERMINAL (MACHINE:PORT:TERMINAL for an explicit port) or http://host:port/TERMINAL,
where TERMINAL is an id prefix from `athena remote ls` or a handle such as claude or codex#2.

Your own devices (same Tailscale account) need no token; others need --token or ATHENA_REMOTE_TOKEN.
The remote machine needs Settings > System > Remote access turned on.
"""


def register(sub: argparse._SubParsersAction) -> None:
    """Add the ``remote`` command group to the top-level subparsers."""
    # Accepted on the group and on every leaf; SUPPRESS keeps a value given
    # earlier from being reset by a later parser's default (see cli/__main__.py).
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument(
        "--json", action="store_true", default=argparse.SUPPRESS, help="Emit raw JSON instead of human output."
    )
    shared.add_argument(
        "--port",
        type=_port_type,
        default=argparse.SUPPRESS,
        help=f"Remote access port (default {DEFAULT_PORT}, or ATHENA_REMOTE_PORT).",
    )
    shared.add_argument(
        "--token",
        default=argparse.SUPPRESS,
        help="Access token of the one machine a command names, for machines not on your Tailscale account "
        "(or ATHENA_REMOTE_TOKEN). Never sent by `machines` or a bare `ls`, which contact every peer.",
    )

    group = sub.add_parser(
        "remote",
        parents=[shared],
        help="Drive Athena terminals on your other machines (Tailscale).",
        description="Drive Athena terminals on your other machines over Tailscale.",
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    rsub = group.add_subparsers(dest="sub", required=True, metavar="COMMAND")

    def leaf(name: str, func, **kw: Any) -> argparse.ArgumentParser:  # noqa: ANN001 - handler
        parser = rsub.add_parser(name, parents=[shared], **kw)
        parser.set_defaults(func=func)
        return parser

    leaf("machines", cmd_remote_machines, help="List your other computers and whether Athena answers there.")

    p = leaf("ls", cmd_remote_ls, help="List terminals on MACHINE, or on every ready machine.")
    p.add_argument("machine", nargs="?", metavar="MACHINE")
    p.add_argument("--all", action="store_true", help="Include exited terminals.")

    p = leaf("spawn", cmd_remote_spawn, help="Start terminals/agents on MACHINE.")
    p.add_argument("machine", metavar="MACHINE")
    p.add_argument("kind", metavar="KIND", help=" | ".join(TERMINAL_KINDS))
    p.add_argument(
        "--workspace",
        "-w",
        required=True,
        metavar="PATH",
        help="Folder ON THAT MACHINE. Quote a leading ~ ('~/src/app') to mean its home.",
    )
    p.add_argument("--task", default=None, help="Initial prompt for the agent.")
    p.add_argument("--count", type=int, default=1, help=f"How many (1-{MAX_SPAWN_COUNT}, default 1).")
    p.add_argument("--title", default=None, help="Pane title.")
    p.add_argument(
        "--memory-override", action="store_true", help="Launch even if the machine reports memory pressure."
    )

    p = leaf("open", cmd_remote_open, help="Open a workspace folder in MACHINE's Athena window.")
    p.add_argument("machine", metavar="MACHINE")
    p.add_argument("path", metavar="PATH", help="Folder ON THAT MACHINE (quote a leading ~).")
    p.add_argument("--select", action="store_true", help="Also switch that window to it.")

    p = leaf("tail", cmd_remote_tail, help="Print a terminal's output (--follow to stream it).")
    p.add_argument("target", metavar="TARGET")
    p.add_argument("--lines", "-n", type=int, default=None, help="Only the last N lines of the backlog.")
    p.add_argument(
        "--chars", type=int, default=DEFAULT_BUFFER_CHARS, help=f"Backlog size (default {DEFAULT_BUFFER_CHARS})."
    )
    p.add_argument("--follow", "-f", action="store_true", help="Keep streaming until the process exits.")

    p = leaf("say", cmd_remote_say, help="Type TEXT into a terminal and submit it (Enter).")
    p.add_argument("target", metavar="TARGET")
    p.add_argument("text", nargs="+", metavar="TEXT")

    p = leaf("keys", cmd_remote_keys, help="Send raw keystrokes (no Enter appended).")
    p.add_argument("target", metavar="TARGET")
    p.add_argument(
        "data", nargs="?", default=None, metavar="DATA", help=r"Text with escapes: \r \n \t \e \xHH \\"
    )
    p.add_argument(
        "--key",
        action="append",
        type=str.lower,
        choices=list(NAMED_KEYS),
        metavar="NAME",
        help=f"Named key, sent after DATA; repeatable ({', '.join(NAMED_KEYS)}).",
    )

    p = leaf("kill", cmd_remote_kill, help="Kill a terminal.")
    p.add_argument("target", metavar="TARGET")
