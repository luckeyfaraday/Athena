import { execFile } from "node:child_process";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { app } from "electron";
import type { ControlAccessDecision } from "./control-access.js";
import { createControlRequestListener } from "./control-server.js";
import {
  AuthFailureLimiter,
  evaluateRemoteAccess,
  generateRemoteToken,
  normalizeAddress,
  normalizeRemotePort,
  parseTailscaleStatus,
  readRemoteAccessConfig,
  remoteUrl,
  RemoteListenerSet,
  tailscaleAddresses,
  writeRemoteAccessConfig,
  type RemoteAccessConfig,
  type TailscaleStatus,
} from "./remote-access.js";

// Opt-in remote access to this machine's Electron control API over Tailscale,
// so another Athena (or a script) on the same tailnet can list, watch, type
// into, and launch terminals here. Off by default. See remote-access.ts for the
// security model.

export type RemoteAccessState = {
  enabled: boolean;
  port: number;
  /** URLs this machine is reachable at right now, one per bound Tailscale address. */
  urls: string[];
  /** MagicDNS URL, when the Tailscale CLI reported a DNS name. */
  dnsUrl: string | null;
  tailscale: {
    /** True when a Tailscale address is present on a local network interface. */
    detected: boolean;
    backendState: string | null;
    dnsName: string | null;
    hostName: string | null;
  };
  hasToken: boolean;
  errors: string[];
  lastRequest: { at: string; peer: string; method: string; path: string } | null;
  lastRejected: { at: string; peer: string; status: number; reason: string } | null;
};

const ADDRESS_RESCAN_INTERVAL_MS = 15_000;
const TAILSCALE_STATUS_TTL_MS = 60_000;
const TAILSCALE_STATUS_TIMEOUT_MS = 3_000;

let config: RemoteAccessConfig | null = null;
let rescanTimer: NodeJS.Timeout | null = null;
let tailscaleStatus: TailscaleStatus | null = null;
let tailscaleStatusAt = 0;
let tailscaleStatusInFlight: Promise<void> | null = null;
let lastRequest: RemoteAccessState["lastRequest"] = null;
let lastRejected: RemoteAccessState["lastRejected"] = null;
const failureLimiter = new AuthFailureLimiter();

const listeners = new RemoteListenerSet(createControlRequestListener({
  source: "remote",
  authorize: authorizeRemoteRequest,
}));

function configPath(): string {
  return path.join(app.getPath("userData"), "remote-access.json");
}

function currentConfig(): RemoteAccessConfig {
  config ??= readRemoteAccessConfig(configPath());
  return config;
}

function saveConfig(next: RemoteAccessConfig): RemoteAccessConfig {
  writeRemoteAccessConfig(configPath(), next);
  config = next;
  return next;
}

function authorizeRemoteRequest(request: IncomingMessage): ControlAccessDecision {
  const peer = normalizeAddress(request.socket.remoteAddress);
  const decision = failureLimiter.blocked(peer)
    ? { ok: false as const, status: 429, reason: "Too many failed remote access attempts; try again in a minute." }
    : evaluateRemoteAccess(
      {
        remoteAddress: peer,
        host: headerValue(request.headers.host),
        origin: headerValue(request.headers.origin),
        authorization: headerValue(request.headers.authorization),
        token: headerValue(request.headers["x-athena-control-token"]),
      },
      { token: currentConfig().token, boundAddresses: listeners.addresses },
    );
  const at = new Date().toISOString();
  if (decision.ok) {
    failureLimiter.recordSuccess(peer);
    const pathname = new URL(request.url ?? "/", "http://remote").pathname;
    lastRequest = { at, peer, method: request.method ?? "GET", path: pathname };
  } else {
    if (decision.status === 401) failureLimiter.recordFailure(peer);
    lastRejected = { at, peer, status: decision.status, reason: decision.reason };
  }
  return decision;
}

export async function startRemoteAccess(): Promise<RemoteAccessState> {
  if (currentConfig().enabled) {
    startRescan();
    await syncListeners();
    void refreshTailscaleStatus();
  }
  return getRemoteAccessState();
}

export async function stopRemoteAccess(): Promise<boolean> {
  stopRescan();
  await listeners.closeAll();
  return true;
}

export async function setRemoteAccessEnabled(enabled: boolean): Promise<RemoteAccessState> {
  const previous = currentConfig();
  saveConfig({ ...previous, enabled, token: previous.token ?? generateRemoteToken() });
  if (enabled) {
    startRescan();
    await syncListeners();
    await refreshTailscaleStatus(true);
  } else {
    await stopRemoteAccess();
  }
  return getRemoteAccessState();
}

export async function setRemoteAccessPort(value: unknown): Promise<RemoteAccessState> {
  const port = normalizeRemotePort(value);
  saveConfig({ ...currentConfig(), port });
  if (currentConfig().enabled) await syncListeners();
  return getRemoteAccessState();
}

/** Issue a new token; every machine paired with the old one must be re-paired. */
export function regenerateRemoteAccessToken(): RemoteAccessState {
  saveConfig({ ...currentConfig(), token: generateRemoteToken() });
  listeners.destroyConnections();
  return getRemoteAccessState();
}

export function getRemoteAccessToken(): string {
  const existing = currentConfig().token;
  if (existing) return existing;
  return saveConfig({ ...currentConfig(), token: generateRemoteToken() }).token as string;
}

export function getRemoteAccessState(): RemoteAccessState {
  const current = currentConfig();
  const port = listeners.port ?? current.port;
  const detected = tailscaleAddresses().length > 0;
  const urls = current.enabled ? listeners.addresses.map((address) => remoteUrl(address, port)) : [];
  const errors = current.enabled ? Object.values(listeners.errors) : [];
  if (current.enabled && !detected) {
    errors.unshift("No Tailscale address found on this machine. Start Tailscale (and sign in); Athena checks again every few seconds.");
  }
  return {
    enabled: current.enabled,
    port: current.port,
    urls,
    dnsUrl: current.enabled && urls.length && tailscaleStatus?.dnsName ? `http://${tailscaleStatus.dnsName}:${port}` : null,
    tailscale: {
      detected,
      backendState: tailscaleStatus?.backendState ?? null,
      dnsName: tailscaleStatus?.dnsName ?? null,
      hostName: tailscaleStatus?.hostName ?? null,
    },
    hasToken: Boolean(current.token),
    errors,
    lastRequest,
    lastRejected,
  };
}

export async function refreshRemoteAccessState(): Promise<RemoteAccessState> {
  if (currentConfig().enabled) await syncListeners();
  await refreshTailscaleStatus(true);
  return getRemoteAccessState();
}

function syncListeners(): Promise<void> {
  const current = currentConfig();
  return listeners.sync(current.enabled ? tailscaleAddresses() : [], current.port);
}

function startRescan(): void {
  if (rescanTimer) return;
  // Tailscale often comes up after Athena (login, laptop resume) and its
  // addresses can change; pick that up without a restart.
  rescanTimer = setInterval(() => {
    void syncListeners().catch(() => undefined);
    void refreshTailscaleStatus();
  }, ADDRESS_RESCAN_INTERVAL_MS);
  rescanTimer.unref?.();
}

function stopRescan(): void {
  if (!rescanTimer) return;
  clearInterval(rescanTimer);
  rescanTimer = null;
}

/** Best effort: the MagicDNS name only adds a friendlier URL in Settings. */
function refreshTailscaleStatus(force = false): Promise<void> {
  if (!force && Date.now() - tailscaleStatusAt < TAILSCALE_STATUS_TTL_MS) return Promise.resolve();
  tailscaleStatusInFlight ??= readTailscaleStatus()
    .then((status) => {
      tailscaleStatus = status;
      tailscaleStatusAt = Date.now();
    })
    .finally(() => {
      tailscaleStatusInFlight = null;
    });
  return tailscaleStatusInFlight;
}

async function readTailscaleStatus(): Promise<TailscaleStatus | null> {
  for (const command of tailscaleCommands()) {
    const status = await new Promise<TailscaleStatus | null>((resolve) => {
      execFile(command, ["status", "--json"], { timeout: TAILSCALE_STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout) => {
        if (error && !stdout) {
          resolve(null);
          return;
        }
        try {
          resolve(parseTailscaleStatus(JSON.parse(stdout)));
        } catch {
          resolve(null);
        }
      });
    });
    if (status) return status;
  }
  return null;
}

function tailscaleCommands(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return ["tailscale", path.win32.join(programFiles, "Tailscale", "tailscale.exe")];
  }
  if (process.platform === "darwin") {
    return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  }
  return ["tailscale"];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
