export type TerminalAttentionKind = "action" | "update";

export const TERMINAL_ATTENTION_SCAN_MAX_CHARS = 4_000;
const TERMINAL_ATTENTION_CARRY_CHARS = 96;

const attentionCuePattern = /\b(approve|approval|permission|allow|confirm|confirmation|required|requires|proceed|continue|waiting|needs?|requesting|press|select|task complete|completed|finished|done|implemented|fixed|passed|succeeded|opened pr|ready for review)\b/i;

/**
 * Classify a bounded tail of a PTY chunk in main so hidden terminals do not
 * need raw renderer IPC merely to update workspace attention badges.
 */
export function classifyTerminalAttention(data: string): TerminalAttentionKind | null {
  const bounded = data.length > TERMINAL_ATTENTION_SCAN_MAX_CHARS
    ? data.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS)
    : data;
  if (!attentionCuePattern.test(bounded)) return null;
  const text = bounded.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ");
  if (/\b(approve|approval|permission|allow|confirm|confirmation|required|requires|proceed|continue)\b/i.test(text)) {
    if (/\b(waiting|needs?|requires?|requesting|press|select|confirm|approve|allow|permission)\b/i.test(text)) {
      return "action";
    }
  }
  if (/\b(task complete|completed|finished|done|implemented|fixed|passed|succeeded|opened pr|ready for review)\b/i.test(text)) {
    return "update";
  }
  return null;
}

/** Keeps only a tiny suffix so attention words split across PTY batches match. */
export class TerminalAttentionTracker {
  private readonly tails = new Map<string, string>();

  classify(id: string, data: string): TerminalAttentionKind | null {
    const combined = `${this.tails.get(id) ?? ""}${data.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS)}`;
    this.tails.set(id, combined.slice(-TERMINAL_ATTENTION_CARRY_CHARS));
    return classifyTerminalAttention(combined);
  }

  clear(id: string): void {
    this.tails.delete(id);
  }
}
