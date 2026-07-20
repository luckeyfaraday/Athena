import { HermesSessionIndex } from "./hermes-session-index.js";
import type { SessionIndexRequest, SessionIndexResponse } from "./session-index-protocol.js";

const index = new HermesSessionIndex();
const IDLE_EXIT_MS = 500;
let activeRequests = 0;
let idleTimer: NodeJS.Timeout | null = null;

function send(message: SessionIndexResponse): void {
  if (process.send && process.connected) process.send(message);
}

process.on("message", (message: SessionIndexRequest) => {
  if (!message || message.type !== "list-hermes" || !message.requestId || !Array.isArray(message.workspaces)) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  activeRequests += 1;
  void index.list(message.workspaces)
    .then(
      (sessions) => send({ type: "response", requestId: message.requestId, ok: true, sessions, diagnostics: index.getDiagnostics() }),
      (error) => send({ type: "response", requestId: message.requestId, ok: false, error: String(error) }),
    )
    .finally(() => {
      activeRequests -= 1;
      scheduleIdleExit();
    });
});

process.on("disconnect", () => process.exit(0));

function scheduleIdleExit(): void {
  if (activeRequests > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeRequests > 0) return;
    process.disconnect?.();
  }, IDLE_EXIT_MS);
}
