import { parseRemoteTerminalId, RemoteRequestError, requestJson, type RemoteSnapshot } from "./remote-client.js";

// Lets a local control API client (Jarvis, the `athena` CLI) work on the user's
// other tailnet machines through this Athena, which already knows them and holds
// their access tokens. Only the local listener offers it: a remote caller never
// hops through this machine to a third one. The desktop app plugs in its
// RemoteClient; a headless server has no directory and relays nothing.
// Kept free of any `electron` import.

export type MachineRelaySource = {
  snapshot: () => Promise<RemoteSnapshot>;
  tokenFor: (machineId: string) => string | null;
};

export type RelayedMachine = {
  id: string;
  name: string;
  os: string | null;
  online: boolean;
  status: string;
  detail: string | null;
  platform: string | null;
  homedir: string | null;
  agents: Array<{ id: string; title: string; kind: string; workspace: string; status: string; createdAt: string }>;
};

export type RelayResult = { status: number; body: Record<string, unknown> };

const DEFAULT_TIMEOUT_MS = 15_000;
const SPAWN_TIMEOUT_MS = 120_000;
const HERMES_DEFAULT_SECONDS = 120;
const HERMES_MAX_SECONDS = 600;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// The request/response routes worth relaying. Streams (/events, /stream) stay
// direct, and nothing here can reconfigure the remote machine itself.
const RELAY_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/machine$/],
  ["GET", /^\/workspaces$/],
  ["GET", /^\/fs\/dirs$/],
  ["GET", /^\/terminals$/],
  ["GET", /^\/terminals\/[^/]+\/(chat|buffer|resolve)$/],
  ["GET", /^\/agent-messages$/],
  ["POST", /^\/agent-messages\/send$/],
  ["POST", /^\/terminals\/(spawn|write|input|keys|kill|rename)$/],
  ["POST", /^\/hermes\/ask$/],
];

let source: MachineRelaySource | null = null;

export function setMachineRelaySource(next: MachineRelaySource | null): void {
  source = next;
}

export function relayAllowed(method: string, pathname: string): boolean {
  return RELAY_ROUTES.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(pathname));
}

/** The other machines this Athena can see, with their agents. Empty without a directory. */
export async function listRelayMachines(): Promise<{ tailscale: RemoteSnapshot["tailscale"]; machines: RelayedMachine[] }> {
  if (!source) return { tailscale: "unavailable", machines: [] };
  const snapshot = await source.snapshot();
  return {
    tailscale: snapshot.tailscale,
    machines: snapshot.machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      os: machine.os,
      online: machine.online,
      status: machine.status,
      detail: machine.detail,
      platform: machine.platform,
      homedir: machine.homedir,
      agents: machine.sessions.map((session) => ({
        // The remote's own id, which is what relayed routes take.
        id: parseRemoteTerminalId(session.id)?.terminalId ?? session.id,
        title: session.title,
        kind: session.kind,
        workspace: session.workspace,
        status: session.status,
        // Lets clients number agents per kind and workspace (codex#1) as Athena does.
        createdAt: session.createdAt,
      })),
    })),
  };
}

/**
 * Forward one control request to a machine and hand back its status and body
 * unchanged, so callers see the remote's own errors (409 not installed, 429 low
 * memory) rather than a generic relay failure.
 */
export async function relayToMachine(machineId: string, method: string, pathAndQuery: string, body: unknown): Promise<RelayResult> {
  const pathname = pathAndQuery.split("?")[0] ?? "";
  if (!relayAllowed(method, pathname)) return { status: 404, body: { error: `Athena does not relay ${method} ${pathname}` } };
  if (!source) return { status: 503, body: { error: "This Athena cannot reach other machines." } };
  const snapshot = await source.snapshot();
  const machine = snapshot.machines.find((candidate) => candidate.id === machineId)
    ?? snapshot.machines.find((candidate) => candidate.name.toLowerCase() === machineId.toLowerCase());
  if (!machine) return { status: 404, body: { error: `No tailnet machine called ${machineId}.` } };
  if (machine.status !== "ready" || !machine.url) {
    return { status: 409, body: { error: notReadyReason(machine.name, machine.status, machine.detail), machine: { id: machine.id, name: machine.name, status: machine.status } } };
  }
  try {
    const result = await requestJson(`${machine.url}${pathAndQuery}`, {
      method,
      body: method === "GET" ? undefined : body ?? {},
      token: source.tokenFor(machine.id),
      timeoutMs: relayTimeoutMs(pathname, body),
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof RemoteRequestError) return { status: error.status || 502, body: error.body ?? { error: error.message } };
    return { status: 502, body: { error: `${machine.name} did not answer: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

export function notReadyReason(name: string, status: string, detail: string | null): string {
  switch (status) {
    case "offline":
      return `${name} is offline.`;
    case "no-athena":
      return `Athena isn't answering on ${name}; it may be closed or have remote access turned off.`;
    case "needs-token":
      return `${name} wants an access token; pair it in Athena's settings under Your machines.`;
    case "refused":
      return `${name} refused the connection${detail ? ` (${detail})` : ""}.`;
    default:
      return `${name} isn't ready yet${detail ? ` (${detail})` : ""}.`;
  }
}

function relayTimeoutMs(pathname: string, body: unknown): number {
  if (pathname === "/terminals/spawn") return SPAWN_TIMEOUT_MS;
  if (pathname === "/hermes/ask") {
    const requested = typeof body === "object" && body !== null ? (body as Record<string, unknown>).timeout_seconds : undefined;
    const seconds = typeof requested === "number" && Number.isFinite(requested) ? Math.min(Math.max(requested, 1), HERMES_MAX_SECONDS) : HERMES_DEFAULT_SECONDS;
    return (seconds + 10) * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}
