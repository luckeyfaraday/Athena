// Pure request-authorization and input-validation logic for the Electron
// control server. Kept free of any `electron` import so it can be unit tested
// in a plain Node process (control-server.ts wires these into the HTTP server).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUncPath, isWindowsPath, normalizeNativePath } from "./platform.js";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
const PROTECTED_POSIX_ROOTS = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"]);
const PROTECTED_WINDOWS_ROOT_NAMES = new Set(["windows", "program files", "program files (x86)", "programdata"]);

export type ControlAccessHeaders = {
  host?: string;
  origin?: string;
  authorization?: string;
  token?: string;
};

export type ControlAccessDecision = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Decide whether a control-server request is authorized. Order matters: cheap
 * header checks (DNS-rebinding via Host, browser CSRF via Origin) run before the
 * constant-time token comparison.
 */
export function evaluateControlAccess(headers: ControlAccessHeaders, token: string | null): ControlAccessDecision {
  const host = hostnameFromHostHeader(headers.host);
  if (host && !LOOPBACK_HOSTNAMES.has(host)) {
    return { ok: false, status: 403, reason: "Control server only accepts loopback Host requests." };
  }
  if (headers.origin && !isLoopbackOrigin(headers.origin)) {
    return { ok: false, status: 403, reason: "Cross-origin requests are not permitted by Electron control." };
  }
  if (!token) {
    return { ok: false, status: 503, reason: "Electron control token is not initialized yet." };
  }
  const presented = bearerToken(headers.authorization) ?? (headers.token?.trim() || undefined);
  if (!presented || !timingSafeEquals(presented, token)) {
    return { ok: false, status: 401, reason: "Missing or invalid Electron control token." };
  }
  return { ok: true };
}

function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (!trimmed) return null;
  // IPv6 literal, e.g. [::1]:1234
  if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1).toLowerCase() || trimmed.toLowerCase();
  const colon = trimmed.indexOf(":");
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : undefined;
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function validatedWorkspacePath(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("project_dir is required.");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) throw new Error("Project directory must be a local filesystem path, not a URL.");
  if (isUncPath(raw)) throw new Error("UNC workspace paths are not supported by Electron control yet.");
  if (!path.isAbsolute(raw) && !isWindowsPath(raw)) throw new Error("Project directory must be an absolute path.");

  const normalized = normalizeNativePath(raw);
  const resolved = fs.realpathSync.native(normalized);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Project directory is not a directory: ${resolved}`);

  const home = fs.realpathSync.native(os.homedir());
  if (sameControlPath(resolved, home)) throw new Error("Refusing to use the home directory as a project root.");

  if (process.platform === "win32" || isWindowsPath(resolved)) {
    rejectProtectedWindowsWorkspace(resolved);
    return resolved;
  }

  const normalizedPosix = path.posix.normalize(resolved);
  if (PROTECTED_POSIX_ROOTS.has(normalizedPosix) || PROTECTED_POSIX_ROOTS.has(path.posix.normalize(normalized))) {
    throw new Error(`Refusing to use protected directory as a project root: ${resolved}`);
  }
  return resolved;
}

function rejectProtectedWindowsWorkspace(workspace: string): void {
  const parsed = path.win32.parse(workspace);
  const normalized = path.win32.normalize(workspace);
  if (sameControlPath(normalized, parsed.root)) {
    throw new Error(`Refusing to use drive root as a project root: ${workspace}`);
  }
  const relativeParts = normalized.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  const firstPart = relativeParts[0]?.toLowerCase();
  if (firstPart && PROTECTED_WINDOWS_ROOT_NAMES.has(firstPart)) {
    throw new Error(`Refusing to use protected Windows directory as a project root: ${workspace}`);
  }
}

export function sameControlPath(left: string, right: string): boolean {
  const normalize = process.platform === "win32" || isWindowsPath(left) || isWindowsPath(right)
    ? (value: string) => path.win32.normalize(value).toLowerCase()
    : (value: string) => path.posix.normalize(value);
  return normalize(left) === normalize(right);
}
