import * as path from "node:path";
import { AgentSessionScanner, combineScanDiagnostics } from "./agent-sessions.js";
import { HermesSessionIndex } from "./hermes-session-index.js";
import type { AgentSession, HermesIndexedSession, SessionIndexRequest, SessionIndexResponse } from "./session-index-protocol.js";

// Stay warm between Sessions-tab refreshes so the per-file metadata caches
// survive; forking Electron-as-Node and re-reading every session file on each
// request is exactly the cost this worker exists to avoid.
const DEFAULT_IDLE_EXIT_MS = 5 * 60_000;
const IDLE_EXIT_MS = idleExitMs(process.env.ATHENA_SESSION_INDEX_IDLE_MS);

const index = new HermesSessionIndex();
const scanner = new AgentSessionScanner();
let activeRequests = 0;
let idleTimer: NodeJS.Timeout | null = null;

function send(message: SessionIndexResponse<HermesIndexedSession> | SessionIndexResponse<AgentSession>): void {
  if (process.send && process.connected) process.send(message);
}

process.on("message", (message: SessionIndexRequest) => {
  if (!message || !message.requestId || !Array.isArray(message.workspaces)) return;
  if (message.type !== "list-hermes" && message.type !== "list-agent-sessions") return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  activeRequests += 1;
  const work = message.type === "list-hermes"
    ? index.list(message.workspaces).then((sessions) => {
      send({ type: "response", requestId: message.requestId, ok: true, sessions, diagnostics: index.getDiagnostics() });
    })
    : listAgentSessions(message.workspaces).then(({ sessions, diagnostics }) => {
      send({ type: "response", requestId: message.requestId, ok: true, sessions, diagnostics });
    });
  void work
    .catch((error) => send({ type: "response", requestId: message.requestId, ok: false, error: String(error) }))
    .finally(() => {
      activeRequests -= 1;
      scheduleIdleExit();
    });
});

process.on("disconnect", () => process.exit(0));

async function listAgentSessions(workspaces: string[]): Promise<{
  sessions: Record<string, AgentSession[]>;
  diagnostics: ReturnType<typeof combineScanDiagnostics>;
}> {
  const startedAt = Date.now();
  const before = scanner.getCounters();
  // One Hermes refresh serves every workspace of the batch. A Hermes failure
  // only empties the Hermes rows, as it did when Hermes had its own request.
  let hermesError: string | null = null;
  const hermes = index.list(workspaces).catch((error) => {
    hermesError = `Hermes session index failed: ${String(error)}`.slice(0, 240);
    return {} as Record<string, HermesIndexedSession[]>;
  });
  const entries = await Promise.all(workspaces.map(async (workspace) => [
    workspace,
    await scanner.list(workspace, async (target) => (await hermes)[path.resolve(target)] ?? []),
  ] as const));
  await hermes;
  return {
    sessions: Object.fromEntries(entries),
    diagnostics: combineScanDiagnostics(before, scanner.getCounters(), Date.now() - startedAt, index.getDiagnostics(), hermesError),
  };
}

function scheduleIdleExit(): void {
  if (activeRequests > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeRequests > 0) return;
    process.disconnect?.();
  }, IDLE_EXIT_MS);
}

function idleExitMs(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_IDLE_EXIT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_EXIT_MS;
}
