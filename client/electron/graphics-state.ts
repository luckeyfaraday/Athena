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

let runtimeDecision: GraphicsDecision | null = null;
let runtimeGpuCrashed = false;
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

export function chooseGraphicsMode(args: {
  platform: NodeJS.Platform;
  preference: GraphicsPreference;
  forceGpu?: boolean;
  forceSafe?: boolean;
  headless?: boolean;
  state?: PersistedGraphicsState | null;
}): GraphicsDecision {
  const state = args.state ?? readGraphicsState();
  if (args.forceGpu) return { mode: "accelerated", reason: "forced by environment", quarantined: false };
  if (args.forceSafe || args.headless) return { mode: "safe", reason: "headless or safe mode forced", quarantined: false };
  if (args.preference === "safe") return { mode: "safe", reason: "safe mode selected", quarantined: false };
  if (state.acceleratedPending) {
    return { mode: "safe", reason: "previous accelerated launch did not exit cleanly", quarantined: true };
  }
  if (state.quarantined) {
    return { mode: "safe", reason: "previous GPU-process crash quarantined acceleration", quarantined: true };
  }
  if (args.platform !== "linux") return { mode: "accelerated", reason: "platform hardware acceleration default", quarantined: false };
  if (args.preference === "accelerated") {
    return { mode: "accelerated", reason: "acceleration selected", quarantined: false };
  }
  // Auto is an accelerated canary on healthy Linux machines. We persist an
  // acceleratedPending marker before Chromium starts, so either a GPU-process
  // crash or an unclean native exit quarantines the next launch into safe mode.
  // A safe-first default has no promotion path and permanently leaves healthy
  // systems on the measured CPU-heavy software compositor.
  return {
    mode: "accelerated",
    reason: state.acceleratedClean ? "previous accelerated launch was clean" : "adaptive Linux acceleration canary",
    quarantined: false,
  };
}

export function beginGraphicsLaunch(decision: GraphicsDecision): void {
  runtimeDecision = decision;
  runtimeGpuCrashed = false;
  const state = readGraphicsState();
  const recoveredUncleanAcceleration = state.acceleratedPending;
  writeGraphicsState({
    ...state,
    quarantined: recoveredUncleanAcceleration ? true : state.quarantined,
    acceleratedClean: recoveredUncleanAcceleration ? false : state.acceleratedClean,
    acceleratedPending: decision.mode === "accelerated",
    lastMode: decision.mode,
    lastGpuCrashAt: recoveredUncleanAcceleration ? new Date().toISOString() : state.lastGpuCrashAt,
    lastGpuCrashReason: recoveredUncleanAcceleration
      ? "Previous accelerated Athena launch did not exit cleanly."
      : state.lastGpuCrashReason,
  });
}

export function markGraphicsLaunchClean(): void {
  if (!runtimeDecision || runtimeGpuCrashed) return;
  const state = readGraphicsState();
  writeGraphicsState({
    ...state,
    lastMode: runtimeDecision.mode,
    acceleratedPending: false,
    acceleratedClean: runtimeDecision.mode === "accelerated" ? true : state.acceleratedClean,
    quarantined: runtimeDecision.mode === "accelerated" ? false : state.quarantined,
    lastCleanAt: new Date().toISOString(),
  });
}

export function quarantineGraphicsAcceleration(reason: string): void {
  runtimeGpuCrashed = true;
  const state = readGraphicsState();
  writeGraphicsState({
    ...state,
    quarantined: true,
    acceleratedClean: false,
    acceleratedPending: false,
    lastGpuCrashAt: new Date().toISOString(),
    lastGpuCrashReason: reason.slice(0, 500),
  });
}

export function clearGraphicsQuarantine(): void {
  const state = readGraphicsState();
  writeGraphicsState({
    ...state,
    quarantined: false,
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
  return {
    ...current,
    reason: state.quarantined
      ? "GPU-process crash detected; crash-safe mode will be used after restart"
      : current.reason,
    quarantined: state.quarantined,
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
    acceleratedClean: false,
    acceleratedPending: false,
    lastMode: null,
    lastGpuCrashAt: null,
    lastGpuCrashReason: null,
    lastCleanAt: null,
  };
}

function readGraphicsState(): PersistedGraphicsState {
  try {
    const value = JSON.parse(fs.readFileSync(graphicsStateFilePath(), "utf8")) as Partial<PersistedGraphicsState>;
    if (!value || value.version !== 1) return defaultGraphicsState();
    return {
      version: 1,
      quarantined: Boolean(value.quarantined),
      acceleratedClean: Boolean(value.acceleratedClean),
      acceleratedPending: Boolean(value.acceleratedPending),
      lastMode: value.lastMode === "safe" || value.lastMode === "accelerated" ? value.lastMode : null,
      lastGpuCrashAt: typeof value.lastGpuCrashAt === "string" ? value.lastGpuCrashAt : null,
      lastGpuCrashReason: typeof value.lastGpuCrashReason === "string" ? value.lastGpuCrashReason : null,
      lastCleanAt: typeof value.lastCleanAt === "string" ? value.lastCleanAt : null,
    };
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
