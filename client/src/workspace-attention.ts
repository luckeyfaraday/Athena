export type WorkspaceAttentionKind = "action" | "update";

export type WorkspaceAttention = {
  kind: WorkspaceAttentionKind;
  count: number;
};

export function classifyTerminalAttention(data: string): WorkspaceAttentionKind | null {
  const text = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ");
  if (/\b(approve|approval|permission|allow|confirm|confirmation|required|requires|proceed|continue)\b/i.test(text)) {
    if (/\b(waiting|needs?|requires?|requesting|press|select|confirm|approve|allow|permission)\b/i.test(text)) return "action";
  }
  if (/\b(task complete|completed|finished|done|implemented|fixed|passed|succeeded|opened pr|ready for review)\b/i.test(text)) return "update";
  return null;
}

export function mergeWorkspaceAttention(
  current: WorkspaceAttention | undefined,
  kind: WorkspaceAttentionKind,
): WorkspaceAttention {
  if (!current) return { kind, count: 1 };
  return {
    kind: current.kind === "action" || kind === "action" ? "action" : "update",
    count: Math.min(current.count + 1, 9),
  };
}
