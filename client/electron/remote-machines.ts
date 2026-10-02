import http from "node:http";
import net from "node:net";
import { remoteUrl, type TailscaleNode, type TailscaleStatus } from "./remote-access.js";

// Finds the other computers on this tailnet and asks each one's Athena who it
// is. Kept free of any `electron` import (dependencies are injectable) so the
// discovery and classification logic can be unit tested in a plain Node process.

export type RemoteMachineStatus =
  /** Tailscale reports the device offline. */
  | "offline"
  /** Online, but nothing answers on the remote access port (Athena closed, remote access off, or a firewall). */
  | "no-athena"
  /** Athena answered and accepted this machine. */
  | "ready"
  /** Athena answered but wants an access token (not your device, or it does not trust devices by account). */
  | "needs-token"
  /** Athena answered and refused for another reason (lockout, network policy). */
  | "refused"
  | "unknown";

export type RemoteMachine = {
  /** Tailscale stable node ID. */
  id: string;
  name: string;
  dnsName: string | null;
  os: string | null;
  online: boolean;
  address: string | null;
  url: string | null;
  owner: string | null;
  /** Signed in to the same Tailscale account as this machine (and untagged). */
  ownDevice: boolean;
  status: RemoteMachineStatus;
  detail: string | null;
  version: string | null;
  platform: string | null;
  homedir: string | null;
  checkedAt: string | null;
};

export type RemoteMachinesState = {
  tailscale: "running" | "stopped" | "unavailable";
  account: string | null;
  port: number;
  machines: RemoteMachine[];
  refreshedAt: string | null;
};

export type MachineProbeResult =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "http"; status: number; error: string | null }
  | { kind: "unreachable"; code: string };

export type MachineProbe = (url: string, token: string | null) => Promise<MachineProbeResult>;

const PROBE_TIMEOUT_MS = 2_500;
// Athena runs on desktops; phones and appliances on the tailnet are left out.
const DESKTOP_OS = new Set(["linux", "windows", "macos", "darwin"]);
const STATUS_ORDER: Record<RemoteMachineStatus, number> = {
  ready: 0,
  "needs-token": 1,
  refused: 2,
  unknown: 3,
  "no-athena": 4,
  offline: 5,
};

export function isDesktopNode(node: TailscaleNode): boolean {
  return Boolean(node.os && DESKTOP_OS.has(node.os.toLowerCase()));
}

export function machineName(node: TailscaleNode): string {
  return node.dnsName?.split(".")[0] || node.hostName || node.addresses[0] || "unknown";
}

export function classifyProbe(result: MachineProbeResult): Pick<RemoteMachine, "status" | "detail" | "version" | "platform" | "homedir"> {
  const none = { version: null, platform: null, homedir: null };
  if (result.kind === "ok") {
    const text = (key: string) => typeof result.body[key] === "string" ? result.body[key] as string : null;
    return { status: "ready", detail: null, version: text("version"), platform: text("platform"), homedir: text("homedir") };
  }
  if (result.kind === "unreachable") {
    return {
      ...none,
      status: "no-athena",
      detail: result.code === "ETIMEDOUT"
        ? "No answer. Athena may be closed, remote access may be off, or a firewall is blocking it."
        : "Athena is not running there, or its remote access is off.",
    };
  }
  if (result.status === 401) {
    return { ...none, status: "needs-token", detail: result.error ?? "Needs this machine's access token." };
  }
  if (result.status === 403 || result.status === 429) {
    return { ...none, status: "refused", detail: result.error ?? `Refused (HTTP ${result.status}).` };
  }
  return { ...none, status: "unknown", detail: result.error ?? `Unexpected answer (HTTP ${result.status}).` };
}

/** The other desktops on the tailnet, each probed on `port` (offline ones are not probed). */
export async function discoverMachines(options: {
  status: TailscaleStatus | null;
  port: number;
  probe?: MachineProbe;
  tokenFor?: (machineId: string) => string | null;
  now?: () => Date;
}): Promise<RemoteMachinesState> {
  const probe = options.probe ?? probeMachine;
  const now = options.now ?? (() => new Date());
  const status = options.status;
  if (!status) return { tailscale: "unavailable", account: null, port: options.port, machines: [], refreshedAt: now().toISOString() };
  const self = status.self;
  const peers = status.peers.filter((peer) => peer.id && peer.id !== self?.id && isDesktopNode(peer));
  const machines = await Promise.all(peers.map(async (peer): Promise<RemoteMachine> => {
    const address = peer.addresses.find((candidate) => net.isIPv4(candidate)) ?? peer.addresses[0] ?? null;
    const url = address ? remoteUrl(address, options.port) : null;
    const ownDevice = Boolean(
      self && self.userId != null && peer.userId === self.userId && peer.tags.length === 0 && self.tags.length === 0,
    );
    const base = {
      id: peer.id as string,
      name: machineName(peer),
      dnsName: peer.dnsName,
      os: peer.os,
      online: peer.online,
      address,
      url,
      owner: peer.loginName,
      ownDevice,
    };
    if (!peer.online || !url) {
      return { ...base, status: "offline", detail: null, version: null, platform: null, homedir: null, checkedAt: null };
    }
    const result = await probe(url, options.tokenFor?.(base.id) ?? null);
    const classified = classifyProbe(result);
    if (classified.status === "needs-token") {
      classified.detail = ownDevice
        ? "Its “Trust my own devices” setting is off, so it needs its access token."
        : "Not on your Tailscale account, so it needs its access token.";
    }
    return { ...base, ...classified, checkedAt: now().toISOString() };
  }));
  machines.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.name.localeCompare(right.name));
  return {
    tailscale: status.backendState && status.backendState !== "Running" ? "stopped" : "running",
    account: self?.loginName ?? null,
    port: options.port,
    machines,
    refreshedAt: now().toISOString(),
  };
}

/** GET /machine on a remote Athena, with its token when one is known. */
export function probeMachine(url: string, token: string | null): Promise<MachineProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MachineProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.get(
      new URL("/machine", url),
      { agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (text.length < 64_000) text += chunk;
        });
        response.on("end", () => {
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
          if (response.statusCode === 200) finish({ kind: "ok", body: record });
          else finish({ kind: "http", status: response.statusCode ?? 0, error: typeof record.error === "string" ? record.error : null });
        });
        response.on("error", () => finish({ kind: "unreachable", code: "ECONNRESET" }));
      },
    );
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    });
    request.on("error", (error: NodeJS.ErrnoException) => finish({ kind: "unreachable", code: error.code ?? "ERROR" }));
  });
}

/** Caches the last discovery and shares one in-flight refresh between callers. */
export class RemoteMachineDirectory {
  private current: RemoteMachinesState | null = null;
  private inFlight: Promise<RemoteMachinesState> | null = null;

  constructor(private readonly load: (fresh: boolean) => Promise<RemoteMachinesState>) {}

  get state(): RemoteMachinesState | null {
    return this.current;
  }

  refresh(fresh = true): Promise<RemoteMachinesState> {
    this.inFlight ??= this.load(fresh)
      .then((next) => {
        this.current = next;
        return next;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The cached state, refreshed in the background once it is older than `maxAgeMs`. */
  async get(maxAgeMs: number): Promise<RemoteMachinesState> {
    if (!this.current) return this.refresh(false);
    const age = this.current.refreshedAt ? Date.now() - Date.parse(this.current.refreshedAt) : Infinity;
    if (!(age < maxAgeMs)) void this.refresh(false).catch(() => undefined);
    return this.current;
  }
}
