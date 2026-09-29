import type { NativeChatMessage } from "./api";
import type { SentPromptBlock } from "./chat-mode";
import type { ChatBlock } from "./chat-parse";

/** Native records trail the send; allow for small clock differences (e.g. WSL). */
const SENT_AT_SLACK_MS = 2_000;
/** Shorter texts must match exactly; containment of a few characters proves nothing. */
const MIN_CONTAINED_CHARS = 12;
/**
 * How long a sent prompt may go unrecorded, while the native session shows no
 * change at all, before the chat trusts the terminal for that turn instead.
 */
export const NATIVE_RECORD_GRACE_MS = 6_000;

const ATTACHMENT_PLACEHOLDER = /\[[^\]\n]*(?:image|pasted)[^\]\n]*\]/gi;
const QUOTED_IMAGE_PATH = /"[^"\n]*\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)"/gi;
const UNMATCHED = -1;
const OUT_OF_WINDOW = -2;

export type NativeChatView = {
  blocks: ChatBlock[];
  /** Sent prompts still waiting for their native record, oldest first. */
  pending: SentPromptBlock[];
};

/** The words both sides agree on: CLIs record attachments differently than they were typed. */
function comparable(text: string): string {
  return text
    .replace(ATTACHMENT_PLACEHOLDER, " ")
    .replace(QUOTED_IMAGE_PATH, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameMessage(recorded: string, sent: string): boolean {
  const left = comparable(recorded);
  const right = comparable(sent);
  if (!left || !right) return false;
  if (left === right) return true;
  return Math.min(left.length, right.length) >= MIN_CONTAINED_CHARS && (left.includes(right) || right.includes(left));
}

/**
 * Native transcript blocks plus the optimistic sends it has not recorded yet.
 *
 * Sent prompts are reconciled in send order, after the last native message
 * visible when they were sent (`nativeAfter`), or by timestamp for broadcasts:
 * first by tolerant text match, then by position, since the CLI may record a
 * prompt differently than it was typed (attachments, injected text). A prompt
 * that is still unmatched once a later prompt has its record will never get
 * one (a slash command, for instance) and is dropped. `confirmed` keeps
 * matches stable across polls.
 */
export function nativeChatView(
  messages: readonly NativeChatMessage[],
  prompts: readonly SentPromptBlock[],
  title: string,
  confirmed: Map<string, string>,
): NativeChatView {
  const livePrompts = new Set(prompts.map((prompt) => prompt.id));
  for (const id of confirmed.keys()) if (!livePrompts.has(id)) confirmed.delete(id);
  const blocks: ChatBlock[] = messages.map((message) => ({
    id: `native-${message.id}`, role: message.role,
    label: message.role === "user" ? "You" : title, text: message.text,
    ...(message.role === "assistant" ? { markdown: true } : {}),
  }));
  const indexById = new Map(messages.map((message, index) => [message.id, index]));
  const claimed = new Set<number>();
  const matched = prompts.map((prompt) => {
    const id = confirmed.get(prompt.id);
    if (id === undefined) return UNMATCHED;
    const index = indexById.get(id);
    if (index === undefined) return OUT_OF_WINDOW;
    claimed.add(index);
    return index;
  });
  const claim = (promptIndex: number, index: number) => {
    matched[promptIndex] = index;
    claimed.add(index);
    confirmed.set(prompts[promptIndex].id, messages[index].id);
  };
  const anchor = (prompt: SentPromptBlock) => (prompt.nativeAfter ? indexById.get(prompt.nativeAfter) ?? -1 : -1);
  const eligible = (prompt: SentPromptBlock, index: number, requireEvidence: boolean) => {
    const message = messages[index];
    if (message.role !== "user" || claimed.has(index)) return false;
    if (prompt.nativeAfter !== undefined || !prompt.sentAt) return true;
    // Broadcasts have no native anchor; timestamps distinguish repeated sends.
    const time = message.timestamp ? Date.parse(message.timestamp) : NaN;
    if (!Number.isFinite(time)) return !requireEvidence;
    return time >= prompt.sentAt - SENT_AT_SLACK_MS;
  };

  let floor = -1;
  prompts.forEach((prompt, promptIndex) => {
    if (matched[promptIndex] !== UNMATCHED) {
      floor = Math.max(floor, matched[promptIndex]);
      return;
    }
    for (let index = Math.max(floor, anchor(prompt)) + 1; index < messages.length; index++) {
      if (eligible(prompt, index, false) && sameMessage(messages[index].text, prompt.text)) {
        claim(promptIndex, index);
        floor = index;
        return;
      }
    }
  });

  // Unmatched sends take the next unclaimed user record between their neighbours'.
  prompts.forEach((prompt, promptIndex) => {
    if (matched[promptIndex] !== UNMATCHED || !prompt.sentAt) return;
    let lower = anchor(prompt);
    for (let earlier = promptIndex - 1; earlier >= 0; earlier--) {
      if (matched[earlier] >= 0) {
        lower = Math.max(lower, matched[earlier]);
        break;
      }
    }
    // A later send whose record already left the window precedes every message in it.
    const later = matched.slice(promptIndex + 1).find((index) => index !== UNMATCHED);
    const upper = later === undefined ? messages.length : Math.max(later, 0);
    for (let index = lower + 1; index < upper; index++) {
      if (eligible(prompt, index, true)) {
        claim(promptIndex, index);
        return;
      }
    }
  });

  const pending = prompts.filter((prompt, promptIndex) => {
    if (matched[promptIndex] !== UNMATCHED) return false;
    // The launch task has no send time; native history shows it once recorded.
    if (!prompt.sentAt) return messages.length === 0;
    return !matched.slice(promptIndex + 1).some((index) => index !== UNMATCHED);
  });
  return { blocks, pending };
}

/** Keep optimistic sends visible until their actual conversation record arrives. */
export function nativeChatBlocks(
  messages: readonly NativeChatMessage[],
  prompts: readonly SentPromptBlock[],
  title: string,
  confirmed: Map<string, string>,
): ChatBlock[] {
  const view = nativeChatView(messages, prompts, title, confirmed);
  return [...view.blocks, ...view.pending];
}

/**
 * The first pending prompt the native session has not recorded, although it
 * has not changed at all since the prompt was sent, for `graceMs`: the pane
 * moved to another session (/clear, /new, /resume) or the prompt never becomes
 * a message. `nativeChangedAt` is when the native snapshot last changed.
 */
export function unrecordedPrompt(
  pending: readonly SentPromptBlock[],
  nativeChangedAt: number,
  now: number,
  graceMs = NATIVE_RECORD_GRACE_MS,
): SentPromptBlock | undefined {
  return pending.find((prompt) => prompt.sentAt !== undefined && nativeChangedAt <= prompt.sentAt && now - prompt.sentAt >= graceMs);
}

/** When `unrecordedPrompt` will next report a prompt, or null if it never will without new input. */
export function nextUnrecordedCheck(
  pending: readonly SentPromptBlock[],
  nativeChangedAt: number,
  graceMs = NATIVE_RECORD_GRACE_MS,
): number | null {
  const due = pending
    .filter((prompt) => prompt.sentAt !== undefined && nativeChangedAt <= prompt.sentAt)
    .map((prompt) => prompt.sentAt! + graceMs);
  return due.length ? Math.min(...due) : null;
}

/**
 * Native history, then, from the first unrecorded prompt on, the terminal's
 * own turns (`terminal` is the parser view, which interleaves every prompt):
 * the live session keeps showing even when the provider records elsewhere.
 */
export function withTerminalTail(
  view: NativeChatView,
  from: SentPromptBlock | undefined,
  terminal: readonly ChatBlock[],
): ChatBlock[] {
  if (!from) return view.pending.length ? [...view.blocks, ...view.pending] : view.blocks;
  const before = view.pending.slice(0, Math.max(0, view.pending.indexOf(from)));
  const at = terminal.findIndex((block) => block.id === from.id);
  // A prompt cut from the front of the parser window precedes all of it.
  return [...view.blocks, ...before, ...(at >= 0 ? terminal.slice(at) : [from, ...terminal])];
}
