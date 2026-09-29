import { lazy, Suspense, type ComponentProps } from "react";
import type { EmbeddedChatTerminal as EmbeddedChatTerminalComponent } from "./EmbeddedChatTerminal";

// The chat view pulls in the Markdown stack (react-markdown, remark-gfm,
// micromark...). Load it only when a pane is actually shown as chat, so the
// terminal-mode startup path never parses it.
const EmbeddedChatTerminalView = lazy(() =>
  import("./EmbeddedChatTerminal").then((module) => ({ default: module.EmbeddedChatTerminal })),
);

export function EmbeddedChatTerminal(props: ComponentProps<typeof EmbeddedChatTerminalComponent>) {
  return (
    <Suspense fallback={<div className="embeddedChatTerminal" aria-busy="true" />}>
      <EmbeddedChatTerminalView {...props} />
    </Suspense>
  );
}
