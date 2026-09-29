import type { EmbeddedTerminalKind, EmbeddedTerminalSession } from "./electron";

export const CODEX_PROMPT_SUBMIT_DELAY_MS = 120;
const chatPromptHistoryEvent = "athena:chat-prompt-history";

export type SentPromptBlock = {
  id: string;
  role: "user";
  label: string;
  text: string;
  marker: number;
};

const sentPromptHistoryBySession = new Map<string, SentPromptBlock[]>();

/**
 * Prompt markers are offsets in a per-session "chat stream" coordinate system
 * that survives chat-view remounts and main-process buffer trimming. The
 * anchor is the last known stream offset plus the raw output just before it;
 * a fresh buffer (attach snapshot, getEmbeddedTerminalBuffer) is mapped into
 * that system by locating the anchor text in it.
 */
export const CHAT_STREAM_ANCHOR_CHARS = 256;

type ChatStreamAnchor = { end: number; tail: string };

const chatStreamAnchorBySession = new Map<string, ChatStreamAnchor>();

/**
 * Stream offset of the end of `buffer`, the terminal's currently retained
 * output (ending "now"). Also re-anchors the session on that buffer. Use it
 * for prompt markers taken from a buffer and as the parser base on attach
 * (`end - buffer.length`).
 */
export function chatStreamEndForBuffer(sessionId: string, buffer: string): number {
  const anchor = chatStreamAnchorBySession.get(sessionId);
  let end = buffer.length;
  if (anchor) {
    const at = anchor.tail ? buffer.lastIndexOf(anchor.tail) : -1;
    // Anchor text found: everything after it is new. Not found: it scrolled
    // out of the buffer (or the stream restarted), so the whole buffer is new.
    end = anchor.end + (at >= 0 ? buffer.length - (at + anchor.tail.length) : buffer.length);
  }
  chatStreamAnchorBySession.set(sessionId, { end, tail: buffer.slice(-CHAT_STREAM_ANCHOR_CHARS) });
  return end;
}

/** Record that the stream is at `end`, with `tail` the raw output just before it. */
export function updateChatStreamAnchor(sessionId: string, end: number, tail: string): void {
  chatStreamAnchorBySession.set(sessionId, { end, tail: tail.slice(-CHAT_STREAM_ANCHOR_CHARS) });
}

export function promptWritesForKind(kind: EmbeddedTerminalKind, prompt: string): string[] {
  return kind === "codex" || kind === "grok" ? [prompt, "\r"] : [`${prompt}\r`];
}

export async function writePromptSequence(
  kind: EmbeddedTerminalKind,
  prompt: string,
  write: (data: string) => Promise<unknown>,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  const writes = promptWritesForKind(kind, prompt);
  await write(writes[0]);
  if (writes.length > 1) {
    await delay(CODEX_PROMPT_SUBMIT_DELAY_MS);
    await write(writes[1]);
  }
}

export function promptHistoryForSession(session: EmbeddedTerminalSession): SentPromptBlock[] {
  const existing = sentPromptHistoryBySession.get(session.id);
  if (existing) return existing;
  const initialTask = session.initialTask?.trim();
  if (!initialTask) return [];
  const initial = [{
    id: `prompt-initial-${session.id}`,
    role: "user" as const,
    label: "You",
    text: initialTask,
    marker: 0,
  }];
  sentPromptHistoryBySession.set(session.id, initial);
  return initial;
}

export function recordChatPromptForSession(sessionId: string, text: string, marker: number): SentPromptBlock[] {
  const block: SentPromptBlock = {
    id: `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "user",
    label: "You",
    text,
    marker,
  };
  const next = [...(sentPromptHistoryBySession.get(sessionId) ?? []).slice(-4), block];
  sentPromptHistoryBySession.set(sessionId, next);
  notifyChatPromptHistoryChanged(sessionId);
  return next;
}

export function subscribeChatPromptHistory(sessionId: string, callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
    if (detail?.sessionId === sessionId) callback();
  };
  window.addEventListener(chatPromptHistoryEvent, listener);
  return () => window.removeEventListener(chatPromptHistoryEvent, listener);
}

function notifyChatPromptHistoryChanged(sessionId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(chatPromptHistoryEvent, { detail: { sessionId } }));
}
