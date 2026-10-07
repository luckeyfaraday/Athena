import { getBackendState } from "./backend.js";
import { requestJson } from "./remote-client.js";
import { isNativeChatSnapshot, MAX_CHAT_RESPONSE_BYTES, type NativeChatSnapshot } from "./chat-protocol.js";
import type { EmbeddedTerminalSession } from "./embedded-terminal.js";

/** Only conversations belonging to an actual terminal can be read remotely. */
export async function terminalChatSnapshot(terminal: EmbeddedTerminalSession): Promise<NativeChatSnapshot> {
  if (terminal.kind === "shell" || !terminal.providerSessionId) return { messages: [], revision: "", missing: true };
  const backend = getBackendState();
  if (!backend.healthy || !backend.baseUrl) throw new Error("Conversation history is unavailable: the host's Python backend is offline.");
  const query = new URLSearchParams({ workspace: terminal.workspace });
  const url = `${backend.baseUrl}/agents/sessions/${encodeURIComponent(terminal.kind)}/${encodeURIComponent(terminal.providerSessionId)}/chat?${query}`;
  const body = await requestJson(url, { timeoutMs: 5_000, deadlineMs: 5_000, maxResponseBytes: MAX_CHAT_RESPONSE_BYTES });
  if (!isNativeChatSnapshot(body)) throw new Error("The host backend returned invalid conversation history.");
  return body;
}
