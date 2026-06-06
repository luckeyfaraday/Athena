import type { EmbeddedTerminalKind, EmbeddedTerminalSpawnOptions } from "./electron";

type HandoffAgentKind = Extract<EmbeddedTerminalKind, "codex" | "opencode" | "claude">;

export function handoffLaunchOptions(kind: HandoffAgentKind, markdown: string): EmbeddedTerminalSpawnOptions {
  const label = kind === "opencode" ? "OpenCode" : kind === "claude" ? "Claude" : "Codex";
  return {
    kind,
    title: `${label} Handoff`,
    cols: 96,
    rows: 28,
    sessionLabel: "From handoff",
    contextMode: "curated",
    contextText: markdown,
  };
}
