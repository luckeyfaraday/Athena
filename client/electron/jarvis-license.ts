import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Offline check that this machine holds a Jarvis license. Jarvis (the Tauri
// HUD in luckeyfaraday/daddys-home, hud/src-tauri/src/license.rs) activates
// with Keygen and keeps the signed machine file in ~/.config/jarvis/license.json.
// Athena never sees or uses the key: it re-verifies that certificate exactly as
// Jarvis does at boot, so a license that boots Jarvis unlocks Jarvis in Athena,
// and nothing else does. Every JSON field besides `certificate` is untrusted.
// Kept free of any `electron` import.

/** Jarvis's public Keygen configuration, as baked into its release builds. */
export type JarvisKeygenConfig = {
  accountId: string;
  productId: string;
  policyId: string;
  publicKeyHex: string;
};

export const JARVIS_KEYGEN: JarvisKeygenConfig = {
  accountId: "9665d42d-4c34-49b5-86bb-2381e3a8d8b2",
  productId: "60d2ac4a-23c5-4f54-9281-79e0d9edc418",
  policyId: "aa73cd46-e56b-4533-8ce9-8bbf580d23cd",
  publicKeyHex: "e7fc30e10176544f5e0b5c362486ea14905efd8c6ceb2050ff496ec564d28511",
};

export type JarvisLicenseState = {
  licensed: boolean;
  /** Why the license does not count, phrased for the settings page. Null when licensed. */
  detail: string | null;
  /** When the signed machine file lapses unless Jarvis refreshes it online (epoch ms). */
  offlineUntil: number | null;
  licenseId: string | null;
  /** Display-only values copied from the untrusted part of license.json. */
  keyMasked: string | null;
  instanceName: string | null;
};

const OFFLINE_TTL_SECS = 30 * 24 * 60 * 60;
// Matches Jarvis: Keygen stamps `issued` with its own clock, so a PC running a
// little slow must still accept a freshly issued file.
const CLOCK_SKEW_SECS = 5 * 60;
const MAX_CERTIFICATE_BYTES = 1024 * 1024;
const MACHINE_FILE_BEGIN = "-----BEGIN MACHINE FILE-----";
const MACHINE_FILE_END = "-----END MACHINE FILE-----";
const FINGERPRINT_PREFIX = "jarvis-ai:keygen:v1:";
const COMMAND_TIMEOUT_MS = 3_000;

/** Jarvis's config root: $XDG_CONFIG_HOME/jarvis, else <home>/.config/jarvis on every OS. */
export function jarvisConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  return path.join(xdg ? xdg : path.join(home, ".config"), "jarvis");
}

export function jarvisLicensePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(jarvisConfigDir(env), "license.json");
}

export type VerifiedMachineFile = {
  machineId: string;
  licenseId: string;
  /** Epoch seconds. */
  expiresAt: number;
};

/**
 * Verify a Keygen machine file the way Jarvis's `verify_machine_file` does:
 * Ed25519 over "machine/" + enc, a bounded TTL, this machine's fingerprint,
 * and Jarvis's account, product and policy. Throws with a readable reason.
 */
export function verifyMachineFile(
  certificate: string,
  config: JarvisKeygenConfig,
  expectedFingerprint: string,
  nowSecs: number,
): VerifiedMachineFile {
  if (certificate.length > MAX_CERTIFICATE_BYTES) throw new Error("the signed machine file is too large");
  const trimmed = certificate.trim();
  if (!trimmed.startsWith(MACHINE_FILE_BEGIN) || !trimmed.endsWith(MACHINE_FILE_END)) {
    throw new Error("the cached entitlement is not a Keygen machine file");
  }
  const body = trimmed.slice(MACHINE_FILE_BEGIN.length, trimmed.length - MACHINE_FILE_END.length).replace(/\s+/g, "");
  const envelope = parseJson(strictBase64(body, "the signed machine file envelope is not valid base64"), "the signed machine file envelope is invalid");
  if (!isRecord(envelope) || typeof envelope.enc !== "string" || typeof envelope.sig !== "string" || typeof envelope.alg !== "string") {
    throw new Error("the signed machine file envelope is invalid");
  }
  if (envelope.alg !== "base64+ed25519") throw new Error("the signed machine file uses an unsupported algorithm");

  const signature = strictBase64(envelope.sig, "the signed machine file signature is not valid base64");
  if (signature.length !== 64) throw new Error("the signed machine file signature has the wrong length");
  const signed = crypto.verify(null, Buffer.from(`machine/${envelope.enc}`, "utf8"), publicKey(config.publicKeyHex), signature);
  if (!signed) throw new Error("the signed machine file signature is invalid");

  const payload = parseJson(strictBase64(envelope.enc, "the signed machine file payload is not valid base64"), "the signed machine file payload is invalid");
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.meta)) {
    throw new Error("the signed machine file payload is invalid");
  }
  const meta = payload.meta;
  if (typeof meta.issued !== "string" || typeof meta.expiry !== "string" || !Number.isSafeInteger(meta.ttl) || (meta.ttl as number) < 0) {
    throw new Error("the signed machine file payload is invalid");
  }
  const ttl = meta.ttl as number;
  const issuedAt = parseTimestamp(meta.issued, "issued");
  const expiresAt = parseTimestamp(meta.expiry, "expiry");
  if (ttl === 0 || ttl > OFFLINE_TTL_SECS) throw new Error("the signed machine file has an unacceptable offline TTL");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > ttl + 1) {
    throw new Error("the signed machine file TTL does not match its timestamps");
  }
  if (issuedAt > nowSecs + CLOCK_SKEW_SECS) throw new Error("the signed machine file is not valid yet (check the system clock)");
  if (expiresAt <= nowSecs) throw new Error("the signed machine file has expired; open Jarvis online to refresh it");

  const machine = resource(payload.data);
  if (!machine || machine.type !== "machines" || !machine.id) throw new Error("the signed machine file has no machine resource");
  if (typeof machine.attributes.fingerprint !== "string") throw new Error("the signed machine file has no fingerprint");
  if (machine.attributes.fingerprint !== expectedFingerprint) throw new Error("the signed machine file belongs to another machine");
  const accountId = relationshipId(machine, "account", "accounts");
  if (!accountId) throw new Error("the signed machine file has no account relationship");
  if (accountId !== config.accountId) throw new Error("the signed machine file belongs to another Keygen account");
  const machineProductId = relationshipId(machine, "product", "products");
  if (!machineProductId) throw new Error("the signed machine file has no product relationship");
  if (machineProductId !== config.productId) throw new Error("the signed machine file belongs to another product");
  const licenseId = relationshipId(machine, "license", "licenses");
  if (!licenseId) throw new Error("the signed machine file has no license relationship");

  const included = Array.isArray(payload.included) ? payload.included.map(resource) : [];
  const license = included.find((candidate) => candidate?.type === "licenses" && candidate.id === licenseId);
  if (!license) throw new Error("the signed machine file does not include its license");
  const licenseAccountId = relationshipId(license, "account", "accounts");
  if (!licenseAccountId) throw new Error("the signed license has no account relationship");
  if (licenseAccountId !== config.accountId) throw new Error("the signed license belongs to another Keygen account");
  if (license.attributes.suspended !== false) throw new Error("the signed machine file contains a suspended license");
  // Like Jarvis: status is Keygen's activity overview, not a validation result,
  // so accept its non-terminal states and lean on `suspended` and expiry.
  const status = license.attributes.status;
  if (status === "EXPIRED" || status === "SUSPENDED" || status === "BANNED") {
    throw new Error("the signed machine file contains a disabled license");
  }
  if (status !== "ACTIVE" && status !== "INACTIVE" && status !== "EXPIRING") {
    throw new Error("the signed machine file has an unknown license status");
  }
  if (!("expiry" in license.attributes)) throw new Error("the signed license has no expiry field");
  const licenseExpiry = license.attributes.expiry;
  if (typeof licenseExpiry === "string") {
    if (parseTimestamp(licenseExpiry, "license expiry") <= nowSecs) throw new Error("the signed license entitlement has expired");
  } else if (licenseExpiry !== null) {
    throw new Error("the signed license has an invalid expiry");
  }
  const productId = relationshipId(license, "product", "products");
  if (!productId) throw new Error("the signed license has no product relationship");
  if (productId !== config.productId) throw new Error("the signed license belongs to another product");
  const policyId = relationshipId(license, "policy", "policies");
  if (!policyId) throw new Error("the signed license has no policy relationship");
  if (policyId !== config.policyId) throw new Error("the signed license belongs to another policy");

  return { machineId: machine.id, licenseId, expiresAt };
}

/** sha256("jarvis-ai:keygen:v1:" + machine id), the fingerprint Jarvis activates with. */
export function jarvisFingerprint(rawMachineId: string): string {
  return crypto.createHash("sha256").update(`${FINGERPRINT_PREFIX}${rawMachineId}`, "utf8").digest("hex");
}

/**
 * The platform machine id Jarvis hashes. Falls back to the install id Jarvis
 * wrote when the OS has none; Athena only reads it, since a machine without one
 * cannot have activated Jarvis.
 */
export async function nativeMachineId(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (process.platform === "linux") {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const value = readTrimmed(file);
      if (value) return value;
    }
  } else if (process.platform === "darwin") {
    const text = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const line = text?.split(/\r?\n/).find((candidate) => candidate.includes("IOPlatformUUID"));
    const value = line?.split("=")[1]?.trim().replace(/^"+|"+$/g, "");
    if (value) return value;
  } else if (process.platform === "win32") {
    const text = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const line = text?.split(/\r?\n/).find((candidate) => candidate.includes("MachineGuid"));
    const value = line?.trim().split(/\s+/).at(-1);
    if (value) return value;
  }
  return readTrimmed(path.join(jarvisConfigDir(env), "install-id"));
}

/** Whether license.json on this machine carries a current, genuine Jarvis machine file. */
export async function readJarvisLicense(
  options: { env?: NodeJS.ProcessEnv; nowMs?: number; config?: JarvisKeygenConfig; machineId?: string | null } = {},
): Promise<JarvisLicenseState> {
  const env = options.env ?? process.env;
  const unlicensed = (detail: string, stored?: Record<string, unknown>): JarvisLicenseState => ({
    licensed: false,
    detail,
    offlineUntil: null,
    licenseId: null,
    keyMasked: stored ? maskKey(stored.key) : null,
    instanceName: stored && typeof stored.instance_name === "string" ? stored.instance_name : null,
  });

  let stored: unknown;
  try {
    const text = fs.readFileSync(jarvisLicensePath(env), "utf8");
    if (text.length > MAX_CERTIFICATE_BYTES * 2) return unlicensed("the Jarvis license file is too large");
    stored = JSON.parse(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unlicensed("Jarvis is not activated on this computer");
    return unlicensed("the Jarvis license file could not be read");
  }
  if (!isRecord(stored)) return unlicensed("the Jarvis license file could not be read");
  if (stored.provider !== "keygen") return unlicensed("the Jarvis license file has an unknown provider", stored);
  if (typeof stored.certificate !== "string" || !stored.certificate) {
    return unlicensed("open Jarvis online once to refresh its license", stored);
  }
  const rawId = options.machineId !== undefined ? options.machineId : await nativeMachineId(env);
  if (!rawId) return unlicensed("this computer's machine id could not be read", stored);
  try {
    const verified = verifyMachineFile(
      stored.certificate,
      options.config ?? JARVIS_KEYGEN,
      jarvisFingerprint(rawId),
      Math.floor((options.nowMs ?? Date.now()) / 1000),
    );
    return {
      licensed: true,
      detail: null,
      offlineUntil: verified.expiresAt * 1000,
      licenseId: verified.licenseId,
      keyMasked: maskKey(stored.key),
      instanceName: typeof stored.instance_name === "string" ? stored.instance_name : null,
    };
  } catch (error) {
    return unlicensed(error instanceof Error ? error.message : String(error), stored);
  }
}

type SignedResource = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
};

function resource(value: unknown): SignedResource | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return null;
  return {
    id: value.id,
    type: value.type,
    attributes: isRecord(value.attributes) ? value.attributes : {},
    relationships: isRecord(value.relationships) ? value.relationships : {},
  };
}

function relationshipId(owner: SignedResource, name: string, expectedType: string): string | null {
  const relationship = owner.relationships[name];
  const data = isRecord(relationship) ? relationship.data : null;
  if (!isRecord(data) || data.type !== expectedType || typeof data.id !== "string") return null;
  return data.id;
}

function publicKey(hex: string): crypto.KeyObject {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("the Keygen Ed25519 public key must be 64 hexadecimal characters");
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(trimmed, "hex").toString("base64url") },
    format: "jwk",
  });
}

// Node's base64 decoder skips characters it doesn't know; Jarvis's rejects
// them, so a certificate that fails there must fail here too.
function strictBase64(value: string, message: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(message);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_CERTIFICATE_BYTES) throw new Error(message);
  return bytes;
}

function parseJson(bytes: Buffer, message: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(message);
  }
}

// RFC 3339 only, as Jarvis parses it; Date.parse alone accepts far looser text.
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function parseTimestamp(value: string, name: string): number {
  const ms = RFC3339.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`the signed machine file has an invalid ${name} timestamp`);
  return Math.floor(ms / 1000);
}

function maskKey(key: unknown): string | null {
  if (typeof key !== "string" || !key) return null;
  return `…${[...key].slice(-8).join("")}`;
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
