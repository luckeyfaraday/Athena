import fs from "node:fs";
import os from "node:os";

import { formatBytes } from "./disk-guard.js";

export { formatBytes };

// Spawning another heavyweight agent (Claude/Codex/Athena Code are each
// ~300-500 MiB resident plus their own MCP server) onto a machine whose RAM and
// swap are already exhausted does not fail cleanly with an OOM kill — it drags
// the whole desktop into swap thrashing, which users experience as Athena
// "freezing all the time." Unlike the disk guard (which prevents an uncatchable
// SIGBUS), this guard is advisory: it warns before launching so the user can
// thin out running agents instead of silently tipping the box over.

export type MemoryLevel = "ok" | "warn" | "critical";

// A point-in-time read of the host's memory situation. Kept as plain numbers so
// classification can be unit tested without a real /proc/meminfo.
export type MemorySnapshot = {
  /** MemAvailable + free swap: what can be allocated before the kernel swaps. Null if unreadable. */
  availableBytes: number | null;
  /** Genuinely free RAM (MemFree), ignoring reclaimable cache. */
  memFreeBytes: number | null;
  swapTotalBytes: number;
  swapFreeBytes: number;
};

export type MemoryStatus = {
  level: MemoryLevel;
  /** MemAvailable + free swap, or null if the probe failed. */
  availableBytes: number | null;
  /** Total physical RAM, for context in user-facing messages. */
  totalBytes: number;
};

// Below this much allocatable memory, launching another ~500 MiB agent will
// almost certainly force the machine into swap and stall the UI.
export const MEMORY_CRITICAL_BYTES = 1024 * 1024 * 1024; // 1 GiB
// Below this we still launch but warn so the user sees the wall coming.
export const MEMORY_WARN_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB
// MemAvailable counts reclaimable page cache, so it can look healthy while the
// machine is already thrashing. Saturated swap plus little truly-free RAM is the
// signal that catches that case (it is exactly the state a busy fleet produces).
export const MEMFREE_CRITICAL_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const SWAP_CRITICAL_RATIO = 0.9;
export const SWAP_WARN_RATIO = 0.5;

function parseMeminfoKib(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readLinuxMemorySnapshot(): MemorySnapshot | null {
  if (process.platform !== "linux") return null;
  let text: string;
  try {
    text = fs.readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null;
  }
  const memAvailableKib = parseMeminfoKib(text, "MemAvailable");
  if (memAvailableKib == null) return null; // Old kernels lack it; fall back below.
  const memFreeKib = parseMeminfoKib(text, "MemFree") ?? memAvailableKib;
  const swapTotalKib = parseMeminfoKib(text, "SwapTotal") ?? 0;
  const swapFreeKib = parseMeminfoKib(text, "SwapFree") ?? 0;
  return {
    availableBytes: (memAvailableKib + swapFreeKib) * 1024,
    memFreeBytes: memFreeKib * 1024,
    swapTotalBytes: swapTotalKib * 1024,
    swapFreeBytes: swapFreeKib * 1024,
  };
}

/**
 * Best estimate of the host's memory headroom. On Linux we read /proc/meminfo so
 * we account for reclaimable cache and swap; elsewhere os.freemem() is the only
 * portable signal, so swap pressure is treated as unknown (zero).
 */
export function readMemorySnapshot(): MemorySnapshot {
  const linux = readLinuxMemorySnapshot();
  if (linux) return linux;
  let free: number | null;
  try {
    free = os.freemem();
    if (!Number.isFinite(free)) free = null;
  } catch {
    free = null;
  }
  return { availableBytes: free, memFreeBytes: free, swapTotalBytes: 0, swapFreeBytes: 0 };
}

export function classifyMemorySnapshot(snapshot: MemorySnapshot): MemoryLevel {
  const { availableBytes, memFreeBytes, swapTotalBytes, swapFreeBytes } = snapshot;
  if (availableBytes == null) return "ok"; // Never block a launch on a failed probe.
  const swapUsedRatio = swapTotalBytes > 0 ? (swapTotalBytes - swapFreeBytes) / swapTotalBytes : 0;
  const memFree = memFreeBytes ?? availableBytes;
  if (availableBytes < MEMORY_CRITICAL_BYTES) return "critical";
  if (swapUsedRatio >= SWAP_CRITICAL_RATIO && memFree < MEMFREE_CRITICAL_BYTES) return "critical";
  if (availableBytes < MEMORY_WARN_BYTES) return "warn";
  if (swapUsedRatio >= SWAP_WARN_RATIO && memFree < MEMORY_WARN_BYTES) return "warn";
  return "ok";
}

export function checkMemoryPressure(): MemoryStatus {
  const snapshot = readMemorySnapshot();
  return {
    level: classifyMemorySnapshot(snapshot),
    availableBytes: snapshot.availableBytes,
    totalBytes: os.totalmem(),
  };
}
