// Remote access to the Electron control server over a Tailscale tailnet.
// Request authorization, Tailscale detection, the persisted config, and the
// per-address HTTP listeners live here. Kept free of any `electron` import so it
// can be unit tested in a plain Node process (remote-control.ts wires it into
// the app and shares control-server.ts's request handler).
//
// Security model: the remote listener binds only to this machine's Tailscale
// addresses (never 0.0.0.0), only answers peers whose source address is on the
// tailnet, refuses browser requests outright, and requires a persistent
// per-machine token that is separate from the local per-launch control token.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  bearerToken,
  hostnameFromHostHeader,
  timingSafeEquals,
  type ControlAccessDecision,
  type ControlAccessHeaders,
} from "./control-access.js";

export const DEFAULT_REMOTE_PORT = 47821;
const MIN_REMOTE_PORT = 1024;
const MAX_REMOTE_PORT = 65535;
const REMOTE_TOKEN_PREFIX = "athena_remote_";

export type RemoteAccessConfig = {
  enabled: boolean;
  port: number;
  token: string | null;
  /** Devices signed in to the same Tailscale account connect without the token. */
  trustOwnDevices: boolean;
};

export type TailscaleNode = {
  /** Stable node ID, e.g. "nhhkvaH74J11CNTRL". */
  id: string | null;
  hostName: string | null;
  /** MagicDNS name without the trailing dot. */
  dnsName: string | null;
  os: string | null;
  online: boolean;
  addresses: string[];
  userId: number | null;
  loginName: string | null;
  tags: string[];
};

export type TailscaleStatus = {
  backendState: string | null;
  dnsName: string | null;
  hostName: string | null;
  addresses: string[];
  self: TailscaleNode | null;
  peers: TailscaleNode[];
};

/** Who is behind a tailnet address, from `tailscale whois --json`. */
export type TailscaleIdentity = {
  nodeId: string | null;
  nodeName: string | null;
  userId: number | null;
  loginName: string | null;
  displayName: string | null;
  tags: string[];
};

export type RemoteAccessHeaders = ControlAccessHeaders & { remoteAddress?: string };

export type RemoteAccessOptions = {
  token: string | null;
  boundAddresses: readonly string[];
  /**
   * The peer is another device signed in to this machine's Tailscale account
   * (see isOwnDevice), so it is let in without the token. Network checks still apply.
   */
  ownDevice?: boolean;
};

/** Strip an IPv6 zone and the IPv4-mapped prefix Node reports for dual-stack sockets. */
export function normalizeAddress(address: string | undefined | null): string {
  let value = String(address ?? "").trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith("::ffff:") && net.isIPv4(value.slice(7))) value = value.slice(7);
  return value;
}

/**
 * Tailscale assigns IPv4 addresses from the CGNAT range 100.64.0.0/10 and IPv6
 * addresses from fd7a:115c:a1e0::/48.
 */
export function isTailscaleAddress(address: string | undefined | null): boolean {
  const value = normalizeAddress(address);
  if (net.isIPv4(value)) {
    const [first, second] = value.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  if (net.isIPv6(value)) return value.startsWith("fd7a:115c:a1e0:");
  return false;
}

/** Local addresses confirmed by a running Tailscale client, IPv4 first. */
export function tailscaleAddresses(
  status: TailscaleStatus | null,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  // Other VPNs and carrier networks use the same CGNAT range. A range match
  // alone cannot establish that traffic arrived through Tailscale.
  if (status?.backendState !== "Running") return [];
  const confirmed = new Set(status.addresses.map(normalizeAddress));
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = normalizeAddress(entry.address);
      if (isTailscaleAddress(address) && confirmed.has(address)) found.add(address);
    }
  }
  return [...found].sort((left, right) => {
    const leftV4 = net.isIPv4(left) ? 0 : 1;
    const rightV4 = net.isIPv4(right) ? 0 : 1;
    return leftV4 - rightV4 || left.localeCompare(right);
  });
}

export function remoteUrl(address: string, port: number): string {
  return net.isIPv6(address) ? `http://[${address}]:${port}` : `http://${address}:${port}`;
}

/**
 * Accept the Host names a tailnet peer would legitimately use: one of the bound
 * Tailscale addresses, a MagicDNS name (`machine.tailnet.ts.net`), or a bare
 * MagicDNS short name (`machine`). Anything else -- in particular an attacker's
 * domain rebound to a tailnet address -- is refused.
 */
export function remoteHostAllowed(hostHeader: string | undefined, boundAddresses: readonly string[]): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  const bare = normalizeAddress(hostname);
  if (boundAddresses.some((address) => normalizeAddress(address) === bare)) return true;
  if (net.isIP(bare) || bare === "localhost") return false;
  if (bare.endsWith(".ts.net") && /^[a-z0-9.-]+$/.test(bare)) return true;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(bare) && !/^\d+$/.test(bare);
}

/**
 * Decide whether a remote control request is authorized. Network checks (tailnet
 * peer, Host, no browser Origin) run before the constant-time token comparison.
 */
export function evaluateRemoteAccess(headers: RemoteAccessHeaders, options: RemoteAccessOptions): ControlAccessDecision {
  if (!isTailscaleAddress(headers.remoteAddress)) {
    return { ok: false, status: 403, reason: "Remote control only accepts peers on your tailnet." };
  }
  if (!remoteHostAllowed(headers.host, options.boundAddresses)) {
    return { ok: false, status: 403, reason: "Remote control only accepts Tailscale addresses and MagicDNS names as Host." };
  }
  // Remote clients are other Athena instances or scripts, never web pages. A
  // browser always sends Origin on cross-origin and state-changing requests.
  if (headers.origin) {
    return { ok: false, status: 403, reason: "Browser requests are not accepted by remote control." };
  }
  if (options.ownDevice) return { ok: true };
  if (!options.token) {
    return { ok: false, status: 503, reason: "Remote access token is not initialized." };
  }
  const presented = bearerToken(headers.authorization) ?? (headers.token?.trim() || undefined);
  if (!presented || !timingSafeEquals(presented, options.token)) {
    return { ok: false, status: 401, reason: "Missing or invalid remote access token." };
  }
  return { ok: true };
}

/**
 * True when the identity Tailscale reports for a peer is another device of the
 * account this machine is signed in to. Tagged devices are excluded on either
 * side: all tagged nodes share one pseudo-user, so two tagged servers would
 * otherwise "own" each other. This machine itself is excluded too, so another
 * OS user on this machine cannot skip the token by dialing its tailnet address.
 */
export function isOwnDevice(identity: TailscaleIdentity | null, self: TailscaleNode | null): boolean {
  if (!identity || !self) return false;
  if (identity.userId == null || self.userId == null) return false;
  if (identity.tags.length > 0 || self.tags.length > 0) return false;
  if (!identity.nodeId || !self.id || identity.nodeId === self.id) return false;
  return identity.userId === self.userId;
}

/**
 * Per-peer lockout after repeated bad tokens. The token is 256 bits so guessing
 * is already infeasible; this keeps a misbehaving peer from hammering the
 * handler and makes the attempt visible in Settings.
 */
export class AuthFailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(peer: string): boolean {
    return this.recent(peer).length >= this.maxFailures;
  }

  recordFailure(peer: string): void {
    const recent = this.recent(peer);
    recent.push(this.now());
    this.failures.set(peer, recent);
  }

  recordSuccess(peer: string): void {
    this.failures.delete(peer);
  }

  private recent(peer: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(peer) ?? []).filter((at) => at > cutoff);
    if (recent.length) this.failures.set(peer, recent);
    else this.failures.delete(peer);
    return recent;
  }
}

export function generateRemoteToken(): string {
  return `${REMOTE_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

export function normalizeRemotePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_REMOTE_PORT || port > MAX_REMOTE_PORT) {
    throw new Error(`Remote access port must be a whole number from ${MIN_REMOTE_PORT} to ${MAX_REMOTE_PORT}.`);
  }
  return port;
}

export function readRemoteAccessConfig(filePath: string): RemoteAccessConfig {
  const defaults: RemoteAccessConfig = { enabled: false, port: DEFAULT_REMOTE_PORT, token: null, trustOwnDevices: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
  const record = parsed as Record<string, unknown>;
  let port = DEFAULT_REMOTE_PORT;
  try {
    port = normalizeRemotePort(record.port ?? DEFAULT_REMOTE_PORT);
  } catch {
    // Keep the default for a hand-edited, out-of-range port.
  }
  const token = typeof record.token === "string" && record.token.startsWith(REMOTE_TOKEN_PREFIX) ? record.token : null;
  // Account-based access requires an explicit opt-in.
  return { enabled: record.enabled === true, port, token, trustOwnDevices: record.trustOwnDevices === true };
}

export function writeRemoteAccessConfig(filePath: string, config: RemoteAccessConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 0600: the token authorizes process spawning from other machines.
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/** Pick the fields Athena uses from `tailscale status --json`. */
export function parseTailscaleStatus(value: unknown): TailscaleStatus | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const users = record.User && typeof record.User === "object" ? record.User as Record<string, unknown> : {};
  const selfRecord = record.Self && typeof record.Self === "object" ? record.Self as Record<string, unknown> : null;
  const self = selfRecord ? parseTailscaleNode(selfRecord, users) : null;
  if (self && !self.addresses.length && Array.isArray(record.TailscaleIPs)) {
    self.addresses = addressList(record.TailscaleIPs);
  }
  const peerRecords = record.Peer && typeof record.Peer === "object" ? Object.values(record.Peer as Record<string, unknown>) : [];
  const peers = peerRecords
    .filter((peer): peer is Record<string, unknown> => Boolean(peer) && typeof peer === "object")
    .map((peer) => parseTailscaleNode(peer, users));
  return {
    backendState: typeof record.BackendState === "string" ? record.BackendState : null,
    dnsName: self?.dnsName ?? null,
    hostName: self?.hostName ?? null,
    addresses: self?.addresses ?? [],
    self,
    peers,
  };
}

/** Pick the fields Athena uses from `tailscale whois --json <address>`. */
export function parseTailscaleWhois(value: unknown): TailscaleIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const node = record.Node && typeof record.Node === "object" ? record.Node as Record<string, unknown> : null;
  const profile = record.UserProfile && typeof record.UserProfile === "object" ? record.UserProfile as Record<string, unknown> : null;
  if (!node && !profile) return null;
  const nodeName = stringField(node?.ComputedName) ?? stringField(node?.Name)?.replace(/\.$/, "").split(".")[0] ?? null;
  return {
    nodeId: stringField(node?.StableID),
    nodeName,
    userId: numberField(profile?.ID) ?? numberField(node?.User),
    loginName: stringField(profile?.LoginName),
    displayName: stringField(profile?.DisplayName),
    tags: stringList(node?.Tags),
  };
}

function parseTailscaleNode(record: Record<string, unknown>, users: Record<string, unknown>): TailscaleNode {
  const userId = numberField(record.UserID);
  const user = userId != null && users[String(userId)] && typeof users[String(userId)] === "object"
    ? users[String(userId)] as Record<string, unknown>
    : null;
  return {
    id: stringField(record.ID),
    hostName: stringField(record.HostName),
    dnsName: stringField(record.DNSName)?.replace(/\.$/, "") ?? null,
    os: stringField(record.OS),
    online: record.Online === true,
    addresses: addressList(record.TailscaleIPs),
    userId,
    loginName: stringField(user?.LoginName),
    tags: stringList(record.Tags),
  };
}

function addressList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((ip): ip is string => typeof ip === "string").map(normalizeAddress).filter(isTailscaleAddress)
    : [];
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

type BoundListener = { server: http.Server; sockets: Set<net.Socket> };

/**
 * One HTTP server per Tailscale address, all sharing a request handler. Binding
 * per address (instead of 0.0.0.0) keeps the control API off LAN and public
 * interfaces. `sync` is serialized so a periodic address re-scan and a settings
 * change cannot race each other.
 */
export class RemoteListenerSet {
  private readonly bound = new Map<string, BoundListener>();
  private readonly bindErrors = new Map<string, string>();
  private boundPort: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly handler: http.RequestListener) {}

  get addresses(): string[] {
    return [...this.bound.keys()];
  }

  get port(): number | null {
    return this.bound.size ? this.boundPort : null;
  }

  get errors(): Record<string, string> {
    return Object.fromEntries(this.bindErrors);
  }

  sync(addresses: readonly string[], port: number): Promise<void> {
    const run = this.queue.then(() => this.syncNow(addresses, port));
    this.queue = run.catch(() => undefined);
    return run;
  }

  closeAll(): Promise<void> {
    return this.sync([], this.boundPort ?? DEFAULT_REMOTE_PORT);
  }

  /** Drop live connections (including SSE streams), e.g. after the token rotates. */
  destroyConnections(): void {
    for (const listener of this.bound.values()) {
      for (const socket of listener.sockets) socket.destroy();
    }
  }

  private async syncNow(addresses: readonly string[], port: number): Promise<void> {
    const wanted = new Set(addresses.map(normalizeAddress));
    const portChanged = this.boundPort !== port;
    for (const [address, listener] of [...this.bound]) {
      if (portChanged || !wanted.has(address)) {
        this.bound.delete(address);
        await closeListener(listener);
      }
    }
    for (const address of [...this.bindErrors.keys()]) {
      if (portChanged || !wanted.has(address)) this.bindErrors.delete(address);
    }
    this.boundPort = port;
    for (const address of wanted) {
      if (this.bound.has(address)) continue;
      try {
        this.bound.set(address, await listen(this.handler, address, port));
        this.bindErrors.delete(address);
      } catch (error) {
        this.bindErrors.set(address, describeListenError(error, address, port));
      }
    }
  }
}

function listen(handler: http.RequestListener, address: string, port: number): Promise<BoundListener> {
  const server = http.createServer(handler);
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: address, exclusive: true }, () => {
      server.off("error", reject);
      // A later socket error must not crash the main process.
      server.on("error", () => undefined);
      resolve({ server, sockets });
    });
  });
}

function closeListener(listener: BoundListener, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    listener.server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    listener.server.closeAllConnections?.();
    for (const socket of listener.sockets) socket.destroy();
  });
}

function describeListenError(error: unknown, address: string, port: number): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") return `Port ${port} is already in use on ${address}. Choose another port.`;
  if (code === "EADDRNOTAVAIL") return `${address} is not available yet; Athena will retry.`;
  if (code === "EACCES") return `Not allowed to listen on ${address}:${port}.`;
  return `Could not listen on ${remoteUrl(address, port)}: ${String(error)}`;
}
