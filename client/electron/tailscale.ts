import { execFile } from "node:child_process";
import path from "node:path";
import {
  normalizeAddress,
  parseTailscaleStatus,
  parseTailscaleWhois,
  type TailscaleIdentity,
  type TailscaleStatus,
} from "./remote-access.js";

// Read-only queries to the local Tailscale client through its CLI, which every
// platform ships and which needs no extra privileges for `status` and `whois`.
// Kept free of any `electron` import; results are cached because remote
// requests and discovery ask the same questions over and over.

const STATUS_TTL_MS = 15_000;
const IDENTITY_TTL_MS = 60_000;
const IDENTITY_FAILURE_TTL_MS = 10_000;
const CLI_TIMEOUT_MS = 3_000;

let status: TailscaleStatus | null = null;
let statusAt = 0;
let statusInFlight: Promise<TailscaleStatus | null> | null = null;
const identities = new Map<string, { identity: TailscaleIdentity | null; at: number }>();
const identitiesInFlight = new Map<string, Promise<TailscaleIdentity | null>>();

/** The last status read, without asking Tailscale again. */
export function cachedTailscaleStatus(): TailscaleStatus | null {
  return status;
}

/** `tailscale status --json`, reusing a read younger than `maxAgeMs`. Null when Tailscale is unavailable. */
export function tailscaleStatus(options: { maxAgeMs?: number } = {}): Promise<TailscaleStatus | null> {
  const maxAgeMs = options.maxAgeMs ?? STATUS_TTL_MS;
  if (statusAt && Date.now() - statusAt < maxAgeMs) return Promise.resolve(status);
  statusInFlight ??= runTailscaleJson(["status", "--json"], parseTailscaleStatus)
    .then((next) => {
      status = next;
      statusAt = Date.now();
      return next;
    })
    .finally(() => {
      statusInFlight = null;
    });
  return statusInFlight;
}

/** Who owns the device behind a tailnet address (`tailscale whois --json`). Null when unknown. */
export function tailscaleIdentity(address: string): Promise<TailscaleIdentity | null> {
  const key = normalizeAddress(address);
  const cached = identities.get(key);
  if (cached && Date.now() - cached.at < (cached.identity ? IDENTITY_TTL_MS : IDENTITY_FAILURE_TTL_MS)) {
    return Promise.resolve(cached.identity);
  }
  let pending = identitiesInFlight.get(key);
  if (!pending) {
    pending = runTailscaleJson(["whois", "--json", key], parseTailscaleWhois)
      .then((identity) => {
        identities.set(key, { identity, at: Date.now() });
        return identity;
      })
      .finally(() => {
        identitiesInFlight.delete(key);
      });
    identitiesInFlight.set(key, pending);
  }
  return pending;
}

/** A tailnet address's device name from the cached status, for display only. */
export function tailscalePeerName(address: string): string | null {
  const key = normalizeAddress(address);
  const nodes = status ? [...(status.self ? [status.self] : []), ...status.peers] : [];
  const node = nodes.find((candidate) => candidate.addresses.includes(key));
  return node?.hostName ?? node?.dnsName?.split(".")[0] ?? null;
}

async function runTailscaleJson<T>(args: string[], parse: (value: unknown) => T | null): Promise<T | null> {
  for (const command of tailscaleCommands()) {
    const result = await new Promise<T | null>((resolve) => {
      execFile(command, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 8_000_000 }, (error, stdout) => {
        if (error && !stdout) {
          resolve(null);
          return;
        }
        try {
          resolve(parse(JSON.parse(stdout)));
        } catch {
          resolve(null);
        }
      });
    });
    if (result) return result;
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
