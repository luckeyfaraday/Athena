import type { NativeChatMessage } from "./api";
import type { SentPromptBlock } from "./chat-mode";
import type { ChatBlock } from "./chat-parse";

/** Keep optimistic sends visible until their actual conversation record arrives. */
export function nativeChatBlocks(
  messages: readonly NativeChatMessage[],
  prompts: readonly SentPromptBlock[],
  title: string,
  confirmed: Map<string, string>,
): ChatBlock[] {
  const livePrompts = new Set(prompts.map((prompt) => prompt.id));
  for (const id of confirmed.keys()) if (!livePrompts.has(id)) confirmed.delete(id);
  const blocks: ChatBlock[] = messages.map((message) => ({
    id: `native-${message.id}`, role: message.role,
    label: message.role === "user" ? "You" : title, text: message.text,
  }));
  let matchedThrough = -1;
  for (const prompt of prompts) {
    const confirmedId = confirmed.get(prompt.id);
    if (confirmedId) {
      matchedThrough = Math.max(matchedThrough, messages.findIndex((message) => message.id === confirmedId));
      continue;
    }
    const anchor = prompt.nativeAfter ? messages.findIndex((message) => message.id === prompt.nativeAfter) : -1;
    const index = messages.findIndex((message, index) => {
      if (index <= Math.max(anchor, matchedThrough) || message.role !== "user" || message.text.trim() !== prompt.text.trim()) return false;
      // Broadcasts have no native anchor; timestamps distinguish repeated sends.
      const time = message.timestamp ? Date.parse(message.timestamp) : NaN;
      return prompt.nativeAfter !== undefined || !prompt.sentAt || !Number.isFinite(time) || time >= prompt.sentAt - 1_000;
    });
    if (index >= 0) {
      confirmed.set(prompt.id, messages[index].id);
      matchedThrough = index;
    } else if (prompt.sentAt || messages.length === 0) {
      blocks.push(prompt);
    }
  }
  return blocks;
}
