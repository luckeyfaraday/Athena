import path from "node:path";
import type { IncomingMessage } from "node:http";
import { app } from "electron";
import type { ControlAccessDecision } from "./control-access.js";
import { createControlRequestListener } from "./control-server.js";
import {
  AuthFailureLimiter,
  evaluateRemoteAccess,
  generateRemoteToken,
  isOwnDevice,
  normalizeAddress,
  normalizeRemotePort,
  readRemoteAccessConfig,
  remoteUrl,
  RemoteListenerSet,
  tailscaleAddresses,
  writeRemoteAccessConfig,
  type RemoteAccessConfig,
  type RemoteAccessHeaders,
} from "./remote-access.js";
import { cachedTailscaleStatus, tailscaleIdentity, tailscalePeerName, tailscaleStatus } from "./tailscale.js";

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
  trustOwnDevices: boolean;
  tailscale: {
    /** True when a local address is confirmed by the running Tailscale client. */
    detected: boolean;
    backendState: string | null;
    dnsName: string | null;
    hostName: string | null;
    /** The Tailscale account this machine is signed in to. */
    account: string | null;
  };
  hasToken: boolean;
  errors: string[];
  lastRequest: {
    at: string;
    peer: string;
    /** Device name from Tailscale, when known. */
    device: string | null;
    /** "account": let in as one of your own devices; "token": presented the access token. */
    via: "account" | "token";
    method: string;
    path: string;
  } | null;
  lastRejected: { at: string; peer: string; device: string | null; status: number; reason: string } | null;
};

const ADDRESS_RESCAN_INTERVAL_MS = 15_000;

let config: RemoteAccessConfig | null = null;
let rescanTimer: NodeJS.Timeout | null = null;
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

async function authorizeRemoteRequest(request: IncomingMessage): Promise<ControlAccessDecision> {
  const peer = normalizeAddress(request.socket.remoteAddress);
  const at = new Date().toISOString();
  if (failureLimiter.blocked(peer)) {
    return reject(peer, at, { ok: false, status: 429, reason: "Too many failed remote access attempts; try again in a minute." });
  }
  const headers: RemoteAccessHeaders = {
    remoteAddress: peer,
    host: headerValue(request.headers.host),
    origin: headerValue(request.headers.origin),
    authorization: headerValue(request.headers.authorization),
    token: headerValue(request.headers["x-athena-control-token"]),
  };
  const current = currentConfig();
  const options = { token: current.token, boundAddresses: listeners.addresses };
  let decision = evaluateRemoteAccess(headers, options);
  let via: "account" | "token" = "token";
  // Only a missing or wrong token is worth asking Tailscale about: every
  // network check already passed, and a valid token needs no lookup.
  if (!decision.ok && decision.status === 401 && current.trustOwnDevices) {
    const [identity, status] = await Promise.all([tailscaleIdentity(peer), tailscaleStatus()]);
    if (isOwnDevice(identity, status?.self ?? null)) {
      decision = evaluateRemoteAccess(headers, { ...options, ownDevice: true });
      via = "account";
    }
  }
  if (!decision.ok) {
    if (decision.status === 401) failureLimiter.recordFailure(peer);
    return reject(peer, at, decision);
  }
  failureLimiter.recordSuccess(peer);
  const pathname = new URL(request.url ?? "/", "http://remote").pathname;
  lastRequest = { at, peer, device: tailscalePeerName(peer), via, method: request.method ?? "GET", path: pathname };
  return decision;
}

function reject(peer: string, at: string, decision: Extract<ControlAccessDecision, { ok: false }>): ControlAccessDecision {
  lastRejected = { at, peer, device: tailscalePeerName(peer), status: decision.status, reason: decision.reason };
  return decision;
}

export async function startRemoteAccess(): Promise<RemoteAccessState> {
  if (currentConfig().enabled) {
    startRescan();
    await syncListeners();
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
    await syncListeners({ maxAgeMs: 0 });
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

export function setRemoteAccessTrustOwnDevices(trustOwnDevices: boolean): RemoteAccessState {
  saveConfig({ ...currentConfig(), trustOwnDevices });
  // Connections let in by account (open terminal streams included) must not outlive the setting.
  if (!trustOwnDevices) listeners.destroyConnections();
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

/** The port this machine's remote access uses; discovery assumes peers use the same one. */
export function getRemoteAccessPort(): number {
  return currentConfig().port;
}

export function getRemoteAccessState(): RemoteAccessState {
  const current = currentConfig();
  const status = cachedTailscaleStatus();
  const port = listeners.port ?? current.port;
  const detected = tailscaleAddresses(status).length > 0;
  const urls = current.enabled ? listeners.addresses.map((address) => remoteUrl(address, port)) : [];
  const errors = current.enabled ? Object.values(listeners.errors) : [];
  if (current.enabled && !detected) {
    errors.unshift("No local address confirmed by Tailscale. Make sure the Tailscale CLI is installed, running and signed in; Athena checks again every few seconds.");
  }
  return {
    enabled: current.enabled,
    port: current.port,
    urls,
    dnsUrl: current.enabled && urls.length && status?.dnsName ? `http://${status.dnsName}:${port}` : null,
    trustOwnDevices: current.trustOwnDevices,
    tailscale: {
      detected,
      backendState: status?.backendState ?? null,
      dnsName: status?.dnsName ?? null,
      hostName: status?.hostName ?? null,
      account: status?.self?.loginName ?? null,
    },
    hasToken: Boolean(current.token),
    errors,
    lastRequest,
    lastRejected,
  };
}

export async function refreshRemoteAccessState(): Promise<RemoteAccessState> {
  await syncListeners({ maxAgeMs: 0 });
  return getRemoteAccessState();
}

async function syncListeners(options: { maxAgeMs?: number } = {}): Promise<void> {
  const status = await tailscaleStatus(options);
  // Read the setting after the asynchronous query: disabling access during a
  // status refresh must not reopen listeners when that query completes.
  const current = currentConfig();
  return listeners.sync(current.enabled ? tailscaleAddresses(status) : [], current.port);
}

function startRescan(): void {
  if (rescanTimer) return;
  // Tailscale often comes up after Athena (login, laptop resume) and its
  // addresses can change; pick that up without a restart.
  rescanTimer = setInterval(() => {
    void syncListeners().catch(() => undefined);
  }, ADDRESS_RESCAN_INTERVAL_MS);
  rescanTimer.unref?.();
}

function stopRescan(): void {
  if (!rescanTimer) return;
  clearInterval(rescanTimer);
  rescanTimer = null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
