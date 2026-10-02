// Display helpers for Settings > System > Remote access. Pure functions only,
// so they can be unit tested in Node.

import type { RemoteAccessState, RemoteMachine, RemoteMachinesState } from "./electron";

export type RemoteAccessStatusView = { tone: "ok" | "warn" | "bad"; label: string } | null;

/** No pill while remote access is off: off is a normal, healthy state. */
export function remoteAccessStatusView(state: RemoteAccessState | null): RemoteAccessStatusView {
  if (!state?.enabled) return null;
  if (state.urls.length && !state.errors.length) return { tone: "ok", label: "Listening" };
  if (state.urls.length) return { tone: "warn", label: "Partly listening" };
  if (!state.tailscale.detected) return { tone: "warn", label: "Waiting for Tailscale" };
  return { tone: "bad", label: "Not listening" };
}

/** The address other machines should use: MagicDNS when known, else the first Tailscale IP. */
export function preferredRemoteUrl(state: RemoteAccessState | null): string | null {
  if (!state?.enabled) return null;
  return state.dnsUrl ?? state.urls[0] ?? null;
}

export function remoteAccessCurlExample(state: RemoteAccessState | null): string {
  const url = preferredRemoteUrl(state) ?? `http://<this-machine>:${state?.port ?? 47821}`;
  const withToken = [
    `export ATHENA_TOKEN='<paste token>'`,
    `curl -H "Authorization: Bearer $ATHENA_TOKEN" ${url}/machine`,
    `curl -H "Authorization: Bearer $ATHENA_TOKEN" ${url}/terminals`,
  ];
  if (state?.trustOwnDevices !== true) {
    return ["# On another machine on your tailnet, with this machine's token:", ...withToken].join("\n");
  }
  return [
    "# On another machine signed in to your Tailscale account:",
    `curl ${url}/machine`,
    `curl ${url}/terminals`,
    "",
    "# From a device on another account, with this machine's token:",
    ...withToken,
  ].join("\n");
}

export function remoteActivitySummary(state: RemoteAccessState | null, now = Date.now()): string {
  if (!state?.enabled) return "Remote access is off.";
  const parts: string[] = [];
  if (state.lastRequest) {
    const request = state.lastRequest;
    const how = request.via === "account" ? "your account" : "token";
    parts.push(`Last request ${relativeTime(request.at, now)} from ${peerLabel(request.device, request.peer)} (${how}, ${request.method} ${request.path}).`);
  } else {
    parts.push("No remote requests yet.");
  }
  if (state.lastRejected) {
    const rejected = state.lastRejected;
    parts.push(`Last rejected ${relativeTime(rejected.at, now)} from ${peerLabel(rejected.device, rejected.peer)}: ${rejected.reason}`);
  }
  return parts.join(" ");
}

export function trustOwnDevicesHelp(state: RemoteAccessState | null): string {
  const account = state?.tailscale.account;
  const who = account ? `your Tailscale account (${account})` : "your Tailscale account";
  return state?.trustOwnDevices !== true
    ? `Off: every device needs the access token, even ones signed in to ${who}.`
    : `Devices signed in to ${who} connect without the token. Shared and tagged devices still need it.`;
}

export type MachineStatusView = { tone: "ok" | "warn" | "bad" | "muted"; label: string };

export function machineStatusView(machine: RemoteMachine): MachineStatusView {
  switch (machine.status) {
    case "ready": return { tone: "ok", label: "Ready" };
    case "needs-token": return { tone: "warn", label: "Needs token" };
    case "refused": return { tone: "bad", label: "Refused" };
    case "no-athena": return { tone: "muted", label: "Not answering" };
    case "offline": return { tone: "muted", label: "Offline" };
    default: return { tone: "warn", label: "Unknown" };
  }
}

/** One line under a machine's name: what it is and why it is in its state. */
export function machineDetail(machine: RemoteMachine): string {
  const what = [osLabel(machine.os), machine.address, machine.ownDevice ? null : machine.owner ? `shared by ${machine.owner}` : null]
    .filter(Boolean)
    .join(" · ");
  const why = machine.status === "ready"
    ? machine.version ? `Athena ${machine.version}` : "Athena is answering"
    : machine.status === "offline" ? "Offline in Tailscale" : machine.detail;
  return [what, why].filter(Boolean).join(" — ");
}

export function machinesSummary(state: RemoteMachinesState | null): string {
  if (!state) return "Looking for your machines…";
  if (state.tailscale === "unavailable") return "Tailscale isn't running on this machine, so Athena can't see your other machines.";
  if (state.tailscale === "stopped") return "Tailscale is installed but not connected on this machine.";
  if (!state.machines.length) return "No other computers on your tailnet yet.";
  const ready = state.machines.filter((machine) => machine.status === "ready").length;
  if (ready) return `${ready} of ${state.machines.length} machines ${ready === 1 ? "has" : "have"} Athena ready for this one.`;
  return state.machines.length === 1
    ? "Your other machine doesn't have Athena remote access on yet."
    : `None of your ${state.machines.length} other machines have Athena remote access on yet.`;
}

function osLabel(os: string | null): string | null {
  if (!os) return null;
  const lower = os.toLowerCase();
  if (lower === "linux") return "Linux";
  if (lower === "windows") return "Windows";
  if (lower === "macos" || lower === "darwin") return "macOS";
  return os;
}

function peerLabel(device: string | null, peer: string): string {
  return device ? `${device} (${peer})` : peer;
}

export function parseRemotePortInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1024 && port <= 65535 ? port : null;
}

function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
