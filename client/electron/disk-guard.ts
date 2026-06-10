import fs from "node:fs";
import os from "node:os";

// Low disk space is the root cause of the recurring SIGBUS crash loop on Linux:
// Chromium memory-maps its disk/code caches and the AppImage squashfs, and when
// the backing filesystem cannot satisfy a write-back (ENOSPC) touching those
// mapped pages raises SIGBUS — which is not catchable from JS and takes every
// helper process down at once. The only reliable defense is to refuse to launch
// into that state, so we check free space up front and degrade instead.

export type DiskLevel = "ok" | "warn" | "critical";

export type DiskStatus = {
  level: DiskLevel;
  /** Free bytes on the tightest checked path, or null if it could not be read. */
  freeBytes: number | null;
  /** The path whose volume was the tightest. */
  path: string;
};

// Below this, mmap-backed cache writes are likely to fail and SIGBUS the app.
export const DISK_CRITICAL_BYTES = 512 * 1024 * 1024; // 512 MiB
// Below this we still launch but warn the user before they hit the wall.
export const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export function getFreeBytes(targetPath: string): number | null {
  try {
    const stats = fs.statfsSync(targetPath);
    // Use the unprivileged "available" count, not total free, so we mirror what
    // the app can actually write as a normal user.
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function classifyFreeBytes(freeBytes: number | null): DiskLevel {
  if (freeBytes == null) return "ok"; // Never block startup on a failed probe.
  if (freeBytes < DISK_CRITICAL_BYTES) return "critical";
  if (freeBytes < DISK_WARN_BYTES) return "warn";
  return "ok";
}

/**
 * Inspect the volumes the app writes to most (user data + temp) and report the
 * tightest one. The renderer/Chromium caches live under userDataDir; large
 * transient artifacts and the AppImage mount live under the temp dir.
 */
export function checkDiskSpace(paths: { userDataDir: string; tempDir?: string }): DiskStatus {
  const candidates = [paths.userDataDir, paths.tempDir ?? os.tmpdir()];
  let tightest: DiskStatus = { level: "ok", freeBytes: null, path: candidates[0] };
  for (const candidate of candidates) {
    const freeBytes = getFreeBytes(candidate);
    if (freeBytes == null) continue;
    if (tightest.freeBytes == null || freeBytes < tightest.freeBytes) {
      tightest = { level: classifyFreeBytes(freeBytes), freeBytes, path: candidate };
    }
  }
  return tightest;
}

export function isEnospcError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOSPC",
  );
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
