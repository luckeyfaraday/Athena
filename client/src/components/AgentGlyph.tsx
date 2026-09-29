import type { ReactNode } from "react";
import { TerminalSquare } from "lucide-react";
import type { EmbeddedTerminalKind } from "../electron";
import { AthenaIcon, ClaudeIcon, GrokIcon, HermesIcon, OpenAIIcon, OpenCodeIcon } from "./BrandIcons";

export function agentIcon(kind: EmbeddedTerminalKind, size = 14): ReactNode {
  switch (kind) {
    case "codex": return <OpenAIIcon size={size} />;
    case "claude": return <ClaudeIcon size={size} />;
    case "opencode": return <OpenCodeIcon size={size} />;
    case "hermes": return <HermesIcon size={size} />;
    case "athena": return <AthenaIcon size={size} />;
    case "grok": return <GrokIcon size={size} />;
    default: return <TerminalSquare size={size} />;
  }
}

// A tinted icon tile in the agent's identity color (--agent-<kind> tokens).
export function AgentGlyph({ kind, size = "medium" }: { kind: EmbeddedTerminalKind; size?: "small" | "medium" | "large" }) {
  const iconSize = size === "large" ? 18 : size === "small" ? 11 : 14;
  return (
    <span className={size === "medium" ? `agentGlyph ${kind}` : `agentGlyph ${size} ${kind}`} aria-hidden="true">
      {agentIcon(kind, iconSize)}
    </span>
  );
}
