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

export function promptWritesForKind(kind: EmbeddedTerminalKind, prompt: string): string[] {
  return kind === "codex" ? [prompt, "\r"] : [`${prompt}\r`];
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
