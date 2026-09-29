import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const GRAPHICS_PREFERENCE_KEY = "athena.graphicsMode";

export type GraphicsPreference = "auto" | "safe" | "accelerated";
export type GraphicsMode = "safe" | "accelerated";

export type GraphicsDecision = {
  mode: GraphicsMode;
  reason: string;
  quarantined: boolean;
};

export type PersistedGraphicsState = {
  version: 1;
  quarantined: boolean;
  /** When the current quarantine started (null for none or legacy files). */
  quarantinedAt?: string | null;
  /** Clean safe-mode launches completed since the current quarantine began. */
  safeCleanLaunches?: number;
  /** Consecutive accelerated launches that ended without an orderly shutdown. */
  uncleanAcceleratedExits?: number;
  /**
   * Quarantines since acceleration last proved stable. Drives the exponential
   * quarantine backoff; reset after GRAPHICS_RETRY_CONFIRM_LAUNCHES clean
   * accelerated launches.
   */
  quarantineCount?: number;
  /**
   * Acceleration is being retried after a quarantine expired. While set, the
   * first GPU crash or unclean accelerated exit re-quarantines.
   */
  retrying?: boolean;
  /** Consecutive accelerated launches that shut down cleanly. */
  acceleratedCleanStreak?: number;
  acceleratedClean: boolean;
  /** Set before an accelerated launch and cleared only after orderly shutdown. */
  acceleratedPending: boolean;
  lastMode: GraphicsMode | null;
  lastGpuCrashAt: string | null;
  lastGpuCrashReason: string | null;
  lastCleanAt: string | null;
};

export type GraphicsRuntimeStatus = GraphicsDecision & {
  preference: GraphicsPreference;
  recommendedMode: GraphicsMode;
  restartRequired: boolean;
  lastGpuCrashAt: string | null;
  lastGpuCrashReason: string | null;
};

/**
 * A quarantine is a Linux-only crash-loop guard, not a permanent verdict. The
 * first quarantine lasts this many clean safe-mode sessions or this long,
 * whichever comes first; the next launch then retries acceleration. Each
 * re-quarantine doubles both limits (up to GRAPHICS_QUARANTINE_MAX_BACKOFF_STEPS
 * doublings), so a machine with a persistent native GPU crash spends almost all
 * of its time in safe mode.
 */
export const GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES = 3;
export const GRAPHICS_QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const GRAPHICS_QUARANTINE_MAX_BACKOFF_STEPS = 3;
/**
 * A single unclean exit (kill, logout, OS shutdown) on a machine with no crash
 * history is not evidence of a GPU fault. Only a run of consecutive unclean
 * accelerated exits on Linux is treated as the native crash-loop signature that
 * motivated the guard (#100). During a post-quarantine retry the budget is one.
 */
export const GRAPHICS_UNCLEAN_EXIT_QUARANTINE_THRESHOLD = 2;
/** Clean accelerated launches that prove a retry stable and reset the backoff. */
export const GRAPHICS_RETRY_CONFIRM_LAUNCHES = 3;

let runtimeDecision: GraphicsDecision | null = null;
let runtimeGpuCrashed = false;
let runtimeMarkedClean = false;
const GPU_FAILURE_REASONS = new Set(["abnormal-exit", "crashed", "oom", "launch-failed", "integrity-failure"]);

export function graphicsStateFilePath(): string {
  return path.join(os.homedir(), ".context-workspace", "athena-graphics.json");
}

export function parseGraphicsPreference(value: string | null | undefined): GraphicsPreference {
  return value === "safe" || value === "accelerated" ? value : "auto";
}

export function isGpuFailureReason(reason: string): boolean {
  return GPU_FAILURE_REASONS.has(reason);
}

/**
 * Run launch-state setup only in the process that owns Electron's packaged
 * single-instance lock. The losing process still evaluates the main module
 * while `app.quit()` is being delivered, so relying on that call alone can
 * corrupt the primary instance's pending/clean graphics marker.
 */
export function initializeOwnedGraphicsLaunch(
  ownsApplicationInstance: boolean,
  initialize: () => void,
): boolean {
  if (!ownsApplicationInstance) return false;
  initialize();
  return true;
}

/** Quarantine limits for the current backoff step. */
export function graphicsQuarantineLimits(quarantineCount: number | undefined): { cleanSafeLaunches: number; maxAgeMs: number } {
  const step = Math.min(Math.max((quarantineCount ?? 1) - 1, 0), GRAPHICS_QUARANTINE_MAX_BACKOFF_STEPS);
  return {
    cleanSafeLaunches: GRAPHICS_QUARANTINE_CLEAN_SAFE_LAUNCHES * 2 ** step,
    maxAgeMs: GRAPHICS_QUARANTINE_MAX_AGE_MS * 2 ** step,
  };
}

/** True when a persisted quarantine should still force safe mode. */
export function isGraphicsQuarantineActive(
  state: PersistedGraphicsState,
  platform: NodeJS.Platform = process.platform,
  now: number = Date.now(),
): boolean {
  if (platform !== "linux" || !state.quarantined) return false;
  const limits = graphicsQuarantineLimits(state.quarantineCount);
  if ((state.safeCleanLaunches ?? 0) >= limits.cleanSafeLaunches) return false;
  const startedAt = Date.parse(state.quarantinedAt ?? state.lastGpuCrashAt ?? "");
  // A legacy quarantine without any timestamp has no expiry evidence; retry.
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt < limits.maxAgeMs;
}

function uncleanExitQuarantines(state: PersistedGraphicsState): boolean {
  if (!state.acceleratedPending) return false;
  return Boolean(state.retrying)
    || (state.uncleanAcceleratedExits ?? 0) + 1 >= GRAPHICS_UNCLEAN_EXIT_QUARANTINE_THRESHOLD;
}

export function chooseGraphicsMode(args: {
  platform: NodeJS.Platform;
  preference: GraphicsPreference;
  forceGpu?: boolean;
  forceSafe?: boolean;
  headless?: boolean;
  state?: PersistedGraphicsState | null;
  now?: number;
}): GraphicsDecision {
  if (args.forceGpu) return { mode: "accelerated", reason: "forced by environment", quarantined: false };
  if (args.forceSafe || args.headless) return { mode: "safe", reason: "headless or safe mode forced", quarantined: false };
  if (args.preference === "safe") return { mode: "safe", reason: "safe mode selected", quarantined: false };
  // Windows and macOS drivers are not subject to the Linux native crash loop the
  // quarantine exists for, and software compositing there is a severe
  // regression. Auto always means hardware acceleration; stale Linux-style
  // quarantine markers are ignored (and cleared by beginGraphicsLaunch).
  if (args.platform !== "linux") {
    return {
      mode: "accelerated",
      reason: args.preference === "accelerated" ? "acceleration selected" : "platform hardware acceleration default",
      quarantined: false,
    };
  }
  const state = args.state ?? readGraphicsState();
  const now = args.now ?? Date.now();
  if (uncleanExitQuarantines(state)) {
    return {
      mode: "safe",
      reason: state.retrying
        ? "accelerated retry after a GPU quarantine did not exit cleanly"
        : "previous accelerated launches did not exit cleanly",
      quarantined: true,
    };
  }
  if (isGraphicsQuarantineActive(state, args.platform, now)) {
    return { mode: "safe", reason: "previous GPU-process crash quarantined acceleration", quarantined: true };
  }
  if (state.quarantined) {
    return { mode: "accelerated", reason: "GPU quarantine expired; retrying acceleration", quarantined: false };
  }
  if (args.preference === "accelerated") {
    return { mode: "accelerated", reason: "acceleration selected", quarantined: false };
  }
  // Auto is an accelerated canary on healthy Linux machines. A GPU-process
  // crash (or a run of unclean accelerated exits, tracked via the pending
  // marker written before Chromium starts) quarantines subsequent launches
  // into safe mode until the quarantine expires. A safe-first default has no
  // promotion path and leaves healthy systems on the CPU-heavy software
  // compositor.
  return {
    mode: "accelerated",
    reason: state.acceleratedClean ? "previous accelerated launch was clean" : "adaptive Linux acceleration canary",
    quarantined: false,
  };
}

function quarantinedState(state: PersistedGraphicsState, nowIso: string, reason: string): PersistedGraphicsState {
  return {
    ...state,
    quarantined: true,
    quarantinedAt: nowIso,
    safeCleanLaunches: 0,
    uncleanAcceleratedExits: 0,
    quarantineCount: (state.quarantineCount ?? 0) + 1,
    retrying: false,
    acceleratedCleanStreak: 0,
    acceleratedClean: false,
    acceleratedPending: false,
    lastGpuCrashAt: nowIso,
    lastGpuCrashReason: reason.slice(0, 500),
  };
}

/** Pure launch transition; exported for tests. */
export function nextLaunchGraphicsState(
  state: PersistedGraphicsState,
  decision: GraphicsDecision,
  platform: NodeJS.Platform = process.platform,
  now: Date = new Date(),
): PersistedGraphicsState {
  if (platform !== "linux") {
    // Quarantine never applies here: drop any stale flag (and the crash note
    // that justified it) so the settings page stops reporting it, and skip the
    // pending marker entirely.
    return {
      ...state,
      ...(state.quarantined ? { lastGpuCrashAt: null, lastGpuCrashReason: null } : {}),
      quarantined: false,
      quarantinedAt: null,
      safeCleanLaunches: 0,
      uncleanAcceleratedExits: 0,
      quarantineCount: 0,
      retrying: false,
      acceleratedCleanStreak: 0,
      acceleratedPending: false,
      lastMode: decision.mode,
    };
  }

  const nowIso = now.toISOString();
  const recoveredUncleanAcceleration = state.acceleratedPending;
  let next: PersistedGraphicsState = {
    ...state,
    uncleanAcceleratedExits: recoveredUncleanAcceleration ? (state.uncleanAcceleratedExits ?? 0) + 1 : 0,
    acceleratedCleanStreak: recoveredUncleanAcceleration ? 0 : state.acceleratedCleanStreak ?? 0,
    acceleratedClean: recoveredUncleanAcceleration ? false : state.acceleratedClean,
  };

  if (uncleanExitQuarantines(state)) {
    next = quarantinedState(
      next,
      nowIso,
      state.retrying
        ? "Accelerated retry after a GPU quarantine did not exit cleanly."
        : `${next.uncleanAcceleratedExits} consecutive accelerated Athena launches did not exit cleanly.`,
    );
  } else if (next.quarantined && decision.mode === "accelerated" && !isGraphicsQuarantineActive(next, platform, now.getTime())) {
    // The quarantine expired and this launch is the acceleration retry. Until
    // it proves stable, the first GPU crash or unclean exit re-quarantines with
    // a longer backoff.
    next = { ...next, quarantined: false, quarantinedAt: null, safeCleanLaunches: 0, retrying: true, acceleratedCleanStreak: 0 };
  }

  return {
    ...next,
    acceleratedPending: decision.mode === "accelerated",
    lastMode: decision.mode,
  };
}

/** Pure orderly-shutdown transition; exported for tests. */
export function cleanExitGraphicsState(
  state: PersistedGraphicsState,
  mode: GraphicsMode,
  now: Date = new Date(),
): PersistedGraphicsState {
  if (mode === "safe") {
    return {
      ...state,
      lastMode: mode,
      acceleratedPending: false,
      uncleanAcceleratedExits: 0,
      safeCleanLaunches: state.quarantined ? (state.safeCleanLaunches ?? 0) + 1 : state.safeCleanLaunches ?? 0,
      lastCleanAt: now.toISOString(),
    };
  }
  const acceleratedCleanStreak = (state.acceleratedCleanStreak ?? 0) + 1;
  const confirmed = acceleratedCleanStreak >= GRAPHICS_RETRY_CONFIRM_LAUNCHES;
  return {
    ...state,
    lastMode: mode,
    acceleratedPending: false,
    uncleanAcceleratedExits: 0,
    acceleratedClean: true,
    acceleratedCleanStreak,
    quarantined: false,
    quarantinedAt: null,
    safeCleanLaunches: 0,
    retrying: confirmed ? false : state.retrying ?? false,
    quarantineCount: confirmed ? 0 : state.quarantineCount ?? 0,
    lastCleanAt: now.toISOString(),
  };
}

/** Pure GPU-process crash transition; exported for tests. */
export function gpuCrashGraphicsState(
  state: PersistedGraphicsState,
  reason: string,
  platform: NodeJS.Platform = process.platform,
  now: Date = new Date(),
): PersistedGraphicsState {
  const nowIso = now.toISOString();
  // Outside Linux the crash is recorded for diagnostics only; Chromium already
  // restarts or software-falls-back the GPU process within the session.
  if (platform !== "linux") {
    return {
      ...state,
      quarantined: false,
      quarantinedAt: null,
      safeCleanLaunches: 0,
      acceleratedClean: false,
      acceleratedPending: false,
      lastGpuCrashAt: nowIso,
      lastGpuCrashReason: reason.slice(0, 500),
    };
  }
  return quarantinedState(state, nowIso, reason);
}

export function beginGraphicsLaunch(decision: GraphicsDecision): void {
  runtimeDecision = decision;
  runtimeGpuCrashed = false;
  writeGraphicsState(nextLaunchGraphicsState(readGraphicsState(), decision));
}

/** Record an orderly end of this launch. Idempotent per process. */
export function markGraphicsLaunchClean(): void {
  if (!runtimeDecision || runtimeGpuCrashed || runtimeMarkedClean) return;
  runtimeMarkedClean = true;
  writeGraphicsState(cleanExitGraphicsState(readGraphicsState(), runtimeDecision.mode));
}

export function quarantineGraphicsAcceleration(reason: string): void {
  runtimeGpuCrashed = true;
  writeGraphicsState(gpuCrashGraphicsState(readGraphicsState(), reason));
}

export function clearGraphicsQuarantine(): void {
  const state = readGraphicsState();
  writeGraphicsState({
    ...state,
    quarantined: false,
    quarantinedAt: null,
    safeCleanLaunches: 0,
    uncleanAcceleratedExits: 0,
    quarantineCount: 0,
    retrying: false,
    acceleratedPending: false,
    lastGpuCrashAt: null,
    lastGpuCrashReason: null,
  });
}

export function getGraphicsRuntimeStatus(preference: GraphicsPreference): GraphicsRuntimeStatus {
  const state = readGraphicsState();
  const current = runtimeDecision ?? chooseGraphicsMode({ platform: process.platform, preference, state });
  // While this process is alive, its own pending marker is not evidence of a
  // prior crash. It becomes evidence only if the process dies before clearing
  // it during orderly shutdown.
  const recommendationState = runtimeDecision ? { ...state, acceleratedPending: false } : state;
  const recommended = chooseGraphicsMode({ platform: process.platform, preference, state: recommendationState });
  const quarantined = isGraphicsQuarantineActive(state);
  return {
    ...current,
    reason: quarantined && current.mode === "accelerated"
      ? "GPU-process crash detected; crash-safe mode will be used after restart"
      : current.reason,
    quarantined,
    preference,
    recommendedMode: recommended.mode,
    restartRequired: recommended.mode !== current.mode,
    lastGpuCrashAt: state.lastGpuCrashAt,
    lastGpuCrashReason: state.lastGpuCrashReason,
  };
}

function defaultGraphicsState(): PersistedGraphicsState {
  return {
    version: 1,
    quarantined: false,
    quarantinedAt: null,
    safeCleanLaunches: 0,
    uncleanAcceleratedExits: 0,
    quarantineCount: 0,
    retrying: false,
    acceleratedCleanStreak: 0,
    acceleratedClean: false,
    acceleratedPending: false,
    lastMode: null,
    lastGpuCrashAt: null,
    lastGpuCrashReason: null,
    lastCleanAt: null,
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Validate a parsed state file. Files written before the backoff fields existed
 * that record a GPU crash (or a quarantine) count as one prior quarantine, so
 * their next accelerated launch is a strict retry rather than a fresh
 * two-unclean-exit budget.
 */
export function normalizeGraphicsState(value: unknown): PersistedGraphicsState {
  if (!value || typeof value !== "object") return defaultGraphicsState();
  const raw = value as Partial<PersistedGraphicsState>;
  if (raw.version !== 1) return defaultGraphicsState();
  const quarantined = Boolean(raw.quarantined);
  const lastGpuCrashAt = typeof raw.lastGpuCrashAt === "string" ? raw.lastGpuCrashAt : null;
  const legacy = raw.quarantineCount === undefined;
  const legacyCrashHistory = legacy && (quarantined || lastGpuCrashAt !== null);
  return {
    version: 1,
    quarantined,
    quarantinedAt: typeof raw.quarantinedAt === "string" ? raw.quarantinedAt : null,
    safeCleanLaunches: nonNegativeInteger(raw.safeCleanLaunches),
    uncleanAcceleratedExits: nonNegativeInteger(raw.uncleanAcceleratedExits),
    quarantineCount: legacyCrashHistory ? 1 : nonNegativeInteger(raw.quarantineCount),
    // A quarantined legacy file becomes a retry when its quarantine expires; an
    // unquarantined one with crash history is already running accelerated.
    retrying: typeof raw.retrying === "boolean" ? raw.retrying : legacyCrashHistory && !quarantined,
    acceleratedCleanStreak: nonNegativeInteger(raw.acceleratedCleanStreak),
    acceleratedClean: Boolean(raw.acceleratedClean),
    acceleratedPending: Boolean(raw.acceleratedPending),
    lastMode: raw.lastMode === "safe" || raw.lastMode === "accelerated" ? raw.lastMode : null,
    lastGpuCrashAt,
    lastGpuCrashReason: typeof raw.lastGpuCrashReason === "string" ? raw.lastGpuCrashReason : null,
    lastCleanAt: typeof raw.lastCleanAt === "string" ? raw.lastCleanAt : null,
  };
}

export function readGraphicsState(): PersistedGraphicsState {
  try {
    return normalizeGraphicsState(JSON.parse(fs.readFileSync(graphicsStateFilePath(), "utf8")));
  } catch {
    return defaultGraphicsState();
  }
}

function writeGraphicsState(state: PersistedGraphicsState): void {
  try {
    const filePath = graphicsStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      fs.renameSync(temporary, filePath);
    } catch {
      // Some Windows filesystems do not replace an existing destination with
      // rename. The state is reconstructible, so use a narrow fallback.
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.renameSync(temporary, filePath);
    }
  } catch {
    // Graphics fallback must never block startup or shutdown.
  }
}
