import {
  checkMemoryPressure,
  MEMORY_CRITICAL_BYTES,
  MEMORY_WARN_BYTES,
  type MemoryLevel,
  type MemoryStatus,
} from "./memory-guard.js";

export type LaunchAdmissionSource = "ui" | "control" | "restore" | "internal";
export type LaunchAdmissionDecision = "allow" | "warn" | "reject" | "defer";
export type LaunchAdmissionKind = "shell" | "hermes" | "codex" | "opencode" | "claude" | "athena" | "grok";

export type LaunchAdmissionRequest = {
  source: LaunchAdmissionSource;
  kind: LaunchAdmissionKind;
  count?: number;
  /**
   * A deliberate caller-specific override. UI callers obtain this only after
   * the user confirms the warning dialog; authenticated control callers must
   * explicitly put it in the request body. Restore must never set it silently.
   */
  overrideCritical?: boolean;
};

export type LaunchAdmissionResult = {
  decision: LaunchAdmissionDecision;
  granted: boolean;
  source: LaunchAdmissionSource;
  kind: LaunchAdmissionKind;
  count: number;
  memoryLevel: MemoryLevel;
  overrideUsed: boolean;
  requestedBytes: number;
  alreadyReservedBytes: number;
  projectedAvailableBytes: number | null;
  message: string;
  /** Opaque process-local lease. Settle or release it after the spawn attempt. */
  reservationId: string | null;
};

export type PublicLaunchAdmissionResult = Omit<LaunchAdmissionResult, "reservationId">;

type LaunchReservation = {
  bytes: number;
  count: number;
  kind: LaunchAdmissionKind;
  source: LaunchAdmissionSource;
  expiry: NodeJS.Timeout | null;
};

// This is an admission reservation, not an assertion about exact steady-state
// RSS. The heaviest measured Codex process group was about 621 MiB, including
// its helper/MCP processes, so 640 MiB leaves a small safety margin while a
// multi-pane request reserves its whole burst before the first spawn.
export const HEAVY_LAUNCH_RESERVATION_BYTES = 640 * 1024 * 1024;
// Agent wrappers return from spawn before the CLI and its MCP descendants reach
// steady-state RSS. Keep successful capacity leased briefly so a second request
// cannot race that delayed allocation and observe deceptively high headroom.
export const LAUNCH_RESERVATION_SETTLE_MS = 15_000;
// Spawning several CLI/MCP trees in the same tick causes a short CPU/disk storm
// even when enough memory exists. Admission reserves the whole request first;
// this cadence lets each heavyweight launch establish itself before the next.
export const HEAVY_LAUNCH_STAGGER_MS = 750;

/** A short-lived approval that authorizes exactly one atomic UI request. */
export class OneShotLaunchOverride {
  #expiresAt = 0;

  grant(now = Date.now(), ttlMs = 5_000): void {
    this.#expiresAt = now + Math.max(0, ttlMs);
  }

  consume(now = Date.now()): boolean {
    const granted = this.#expiresAt > now;
    this.#expiresAt = 0;
    return granted;
  }
}

export function estimatedLaunchBytes(kind: LaunchAdmissionKind, count = 1): number {
  const normalizedCount = validLaunchCount(count);
  return kind === "shell" ? 0 : HEAVY_LAUNCH_RESERVATION_BYTES * normalizedCount;
}

export function launchStaggerDelayMs(kind: LaunchAdmissionKind, index: number): number {
  return kind === "shell" || index <= 0 ? 0 : HEAVY_LAUNCH_STAGGER_MS;
}

/**
 * Process-local, synchronous admission gate. JavaScript's run-to-completion
 * semantics make check-and-reserve atomic across concurrent IPC/HTTP requests.
 * Failed capacity is released after spawning; successful capacity stays leased
 * briefly while the OS memory probe catches up with descendant initialization.
 */
export class LaunchAdmissionService {
  readonly #readMemoryStatus: () => MemoryStatus;
  readonly #reservations = new Map<string, LaunchReservation>();
  #nextReservationId = 1;

  constructor(readMemoryStatus: () => MemoryStatus = checkMemoryPressure) {
    this.#readMemoryStatus = readMemoryStatus;
  }

  reserve(request: LaunchAdmissionRequest): LaunchAdmissionResult {
    const count = validLaunchCount(request.count ?? 1);
    const requestedBytes = estimatedLaunchBytes(request.kind, count);
    const status = this.#readMemoryStatus();
    const alreadyReservedBytes = this.reservedBytes();
    const projectedAvailableBytes = status.availableBytes == null
      ? null
      : Math.max(0, status.availableBytes - alreadyReservedBytes - requestedBytes);

    // Shells preserve the previous fail-open behavior. They are small enough
    // that blocking them can prevent the user from recovering a pressured app.
    if (requestedBytes === 0) {
      return resultFor({
        request,
        count,
        status,
        requestedBytes,
        alreadyReservedBytes,
        projectedAvailableBytes,
        decision: "allow",
        message: "Shell launch allowed; heavyweight-agent memory admission does not apply.",
      });
    }

    const projectedLevel = worstMemoryLevel(status.level, levelForProjectedAvailable(projectedAvailableBytes));
    const critical = projectedLevel === "critical";
    if (critical && !request.overrideCritical) {
      const decision: LaunchAdmissionDecision = request.source === "ui" ? "reject" : "defer";
      return resultFor({
        request,
        count,
        status: { ...status, level: projectedLevel },
        requestedBytes,
        alreadyReservedBytes,
        projectedAvailableBytes,
        decision,
        message: criticalMemoryMessage(requestedBytes, count, projectedAvailableBytes, decision),
      });
    }

    const reservationId = `launch-${process.pid}-${this.#nextReservationId}`;
    this.#nextReservationId += 1;
    this.#reservations.set(reservationId, {
      bytes: requestedBytes,
      count,
      kind: request.kind,
      source: request.source,
      expiry: null,
    });
    const overrideUsed = critical && Boolean(request.overrideCritical);
    const decision: LaunchAdmissionDecision = projectedLevel === "ok" && !overrideUsed ? "allow" : "warn";
    return resultFor({
      request,
      count,
      status: { ...status, level: projectedLevel },
      requestedBytes,
      alreadyReservedBytes,
      projectedAvailableBytes,
      decision,
      overrideUsed,
      reservationId,
      message: overrideUsed
        ? `Critical-memory launch override accepted for ${count} ${agentLabel(count)}.`
        : decision === "warn"
          ? `Low-memory launch admitted for ${count} ${agentLabel(count)}.`
          : `Memory admission reserved capacity for ${count} ${agentLabel(count)}.`,
    });
  }

  release(reservation: string | LaunchAdmissionResult | null | undefined): boolean {
    const reservationId = typeof reservation === "string" ? reservation : reservation?.reservationId;
    if (!reservationId) return false;
    const active = this.#reservations.get(reservationId);
    if (!active) return false;
    if (active.expiry) clearTimeout(active.expiry);
    return this.#reservations.delete(reservationId);
  }

  /**
   * Finish a spawn attempt without racing the agent's delayed initialization.
   * Failed/unstarted capacity is released immediately; successfully started
   * capacity remains reserved for a short settling window.
   */
  settle(
    reservation: string | LaunchAdmissionResult | null | undefined,
    launchedCount: number,
    settleMs = LAUNCH_RESERVATION_SETTLE_MS,
  ): boolean {
    const reservationId = typeof reservation === "string" ? reservation : reservation?.reservationId;
    if (!reservationId) return false;
    const active = this.#reservations.get(reservationId);
    if (!active) return false;
    const completed = Number.isFinite(launchedCount)
      ? Math.max(0, Math.min(active.count, Math.floor(launchedCount)))
      : 0;
    if (completed === 0 || active.bytes === 0 || settleMs <= 0) return this.release(reservationId);
    active.count = completed;
    active.bytes = estimatedLaunchBytes(active.kind, completed);
    if (active.expiry) clearTimeout(active.expiry);
    active.expiry = setTimeout(() => {
      this.#reservations.delete(reservationId);
    }, settleMs);
    active.expiry.unref?.();
    return true;
  }

  reservedBytes(): number {
    let total = 0;
    for (const reservation of this.#reservations.values()) total += reservation.bytes;
    return total;
  }

  reservationCount(): number {
    return this.#reservations.size;
  }
}

const sharedLaunchAdmission = new LaunchAdmissionService();

export function reserveLaunchAdmission(request: LaunchAdmissionRequest): LaunchAdmissionResult {
  return sharedLaunchAdmission.reserve(request);
}

export function releaseLaunchAdmission(reservation: string | LaunchAdmissionResult | null | undefined): boolean {
  return sharedLaunchAdmission.release(reservation);
}

export function settleLaunchAdmission(
  reservation: string | LaunchAdmissionResult | null | undefined,
  launchedCount: number,
  settleMs = LAUNCH_RESERVATION_SETTLE_MS,
): boolean {
  return sharedLaunchAdmission.settle(reservation, launchedCount, settleMs);
}

export function publicLaunchAdmission(result: LaunchAdmissionResult): PublicLaunchAdmissionResult {
  const { reservationId: _reservationId, ...publicResult } = result;
  return publicResult;
}

function validLaunchCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Launch admission count must be a positive integer; received ${count}.`);
  }
  return count;
}

function levelForProjectedAvailable(availableBytes: number | null): MemoryLevel {
  if (availableBytes == null) return "ok";
  if (availableBytes < MEMORY_CRITICAL_BYTES) return "critical";
  if (availableBytes < MEMORY_WARN_BYTES) return "warn";
  return "ok";
}

function worstMemoryLevel(left: MemoryLevel, right: MemoryLevel): MemoryLevel {
  const rank: Record<MemoryLevel, number> = { ok: 0, warn: 1, critical: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function criticalMemoryMessage(
  requestedBytes: number,
  count: number,
  projectedAvailableBytes: number | null,
  decision: LaunchAdmissionDecision,
): string {
  const projected = projectedAvailableBytes == null
    ? "unknown projected headroom"
    : `${formatGiB(projectedAvailableBytes)} projected headroom`;
  const action = decision === "defer" ? "deferred" : "blocked";
  return `Launch ${action}: reserving ${formatGiB(requestedBytes)} for ${count} ${agentLabel(count)} leaves ${projected}.`;
}

function resultFor(args: {
  request: LaunchAdmissionRequest;
  count: number;
  status: MemoryStatus;
  requestedBytes: number;
  alreadyReservedBytes: number;
  projectedAvailableBytes: number | null;
  decision: LaunchAdmissionDecision;
  message: string;
  overrideUsed?: boolean;
  reservationId?: string;
}): LaunchAdmissionResult {
  return {
    decision: args.decision,
    granted: args.decision === "allow" || args.decision === "warn",
    source: args.request.source,
    kind: args.request.kind,
    count: args.count,
    memoryLevel: args.status.level,
    overrideUsed: args.overrideUsed ?? false,
    requestedBytes: args.requestedBytes,
    alreadyReservedBytes: args.alreadyReservedBytes,
    projectedAvailableBytes: args.projectedAvailableBytes,
    message: args.message,
    reservationId: args.reservationId ?? null,
  };
}

function agentLabel(count: number): string {
  return count === 1 ? "agent" : "agents";
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
