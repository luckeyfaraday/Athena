export type NativeChatMessage = { id: string; role: "user" | "assistant"; text: string; timestamp: string | null };
export type NativeChatSnapshot = { messages: NativeChatMessage[]; revision: string; missing?: boolean };
export const MAX_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;

export function isNativeChatSnapshot(value: unknown): value is NativeChatSnapshot {
  if (!value || typeof value !== "object") return false;
  const body = value as NativeChatSnapshot;
  return typeof body.revision === "string" && body.revision.length <= 128
    && (body.missing === undefined || typeof body.missing === "boolean")
    && Array.isArray(body.messages) && body.messages.length <= 100
    && body.messages.every((message) => message && typeof message.id === "string"
      && (message.role === "user" || message.role === "assistant") && typeof message.text === "string"
      && (message.timestamp === null || typeof message.timestamp === "string"));
}
