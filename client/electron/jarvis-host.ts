import { findEmbeddedTerminal, onEmbeddedTerminalEvent } from "./embedded-terminal.js";
import { broadcastHostEvent } from "./host-runtime.js";
import { jarvisBridge } from "./jarvis-companion.js";
import type { RemoteAttention } from "./remote-client.js";

// Hooks the Jarvis bridge into this host: windows get its state as it changes,
// and agents finishing or needing the user here are passed to Jarvis to say out
// loud. Shared by the desktop app and the headless server. No `electron` import.

let started = false;

export function startJarvisCompanion(): void {
  if (started) return;
  started = true;
  const bridge = jarvisBridge();
  bridge.subscribe((state) => broadcastHostEvent("jarvis:state", state));
  onEmbeddedTerminalEvent((channel, payload) => {
    if (channel !== "embedded-terminal:attention" || typeof payload !== "object" || payload === null) return;
    const event = payload as { id?: unknown; kind?: unknown; reason?: unknown; message?: unknown };
    if (typeof event.id !== "string" || (event.kind !== "action" && event.kind !== "update")) return;
    const session = findEmbeddedTerminal(event.id);
    if (!session) return;
    bridge.relayAlert({
      machine: null,
      agentKind: session.kind,
      title: session.title,
      workspace: session.workspace,
      terminalId: session.id,
      kind: event.kind,
      reason: typeof event.reason === "string" ? event.reason : "notification",
      message: typeof event.message === "string" ? event.message : null,
    });
  });
  void bridge.start().catch((error) => {
    console.error("Jarvis companion failed to start:", error);
  });
}

/** The desktop's RemoteClient reports other machines' alerts here. */
export function relayRemoteAttentionToJarvis(attention: RemoteAttention): void {
  if (!attention.session) return;
  jarvisBridge().relayAlert({
    machine: attention.machineName,
    agentKind: attention.session.kind,
    title: attention.session.title,
    workspace: attention.session.workspace,
    terminalId: attention.event.id,
    kind: attention.event.kind,
    reason: attention.event.reason,
    message: attention.event.message,
  });
}

export function stopJarvisCompanion(): void {
  jarvisBridge().stop();
}
