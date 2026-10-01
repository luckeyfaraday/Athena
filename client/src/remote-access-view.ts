// Display helpers for Settings > System > Remote access. Pure functions only,
// so they can be unit tested in Node.

import type { RemoteAccessState } from "./electron";

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
  return [
    "# On another machine on your tailnet, with this machine's token:",
    `export ATHENA_TOKEN='<paste token>'`,
    `curl -H "Authorization: Bearer $ATHENA_TOKEN" ${url}/machine`,
    `curl -H "Authorization: Bearer $ATHENA_TOKEN" ${url}/terminals`,
  ].join("\n");
}

export function remoteActivitySummary(state: RemoteAccessState | null, now = Date.now()): string {
  if (!state?.enabled) return "Remote access is off.";
  const parts: string[] = [];
  parts.push(state.lastRequest
    ? `Last request ${relativeTime(state.lastRequest.at, now)} from ${state.lastRequest.peer} (${state.lastRequest.method} ${state.lastRequest.path}).`
    : "No remote requests yet.");
  if (state.lastRejected) {
    parts.push(`Last rejected ${relativeTime(state.lastRejected.at, now)} from ${state.lastRejected.peer}: ${state.lastRejected.reason}`);
  }
  return parts.join(" ");
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
