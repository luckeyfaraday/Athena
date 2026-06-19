export const INPUT_SUBMIT_DELAY_MS = 250;

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

// Interactive raw-mode TUIs whose input editor can swallow a trailing \r when it
// arrives coalesced with the message body (treating it as a literal newline, or
// paste-detecting the burst) instead of submitting. For these we paste the body
// atomically and submit with a separate, isolated Enter. `shell` is line-based and
// submits reliably from a single `text\r`, so it stays on the simple path.
const PASTE_SUBMIT_KINDS = new Set(["codex", "claude", "opencode", "athena", "hermes", "grok"]);

export type TerminalInputWrite = {
  data: string;
  delayAfterMs?: number;
};

export function terminalInputWritesForKind(kind: string, text: string): TerminalInputWrite[] {
  const prompt = stripTrailingSubmit(text);
  if (!prompt) return [{ data: "\r" }];

  if (!PASTE_SUBMIT_KINDS.has(kind)) return [{ data: `${prompt}\r` }];

  // Send the body as an atomic bracketed paste, let the TUI ingest/render it, then
  // submit with an isolated Enter so a multi-line body can't absorb the \r. This is
  // safe even for a TUI that never enabled bracketed paste: the unrecognized
  // \x1b[200~ escape is ignored, and the body text plus the isolated Enter still land.
  return [
    { data: `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`, delayAfterMs: INPUT_SUBMIT_DELAY_MS },
    { data: "\r" },
  ];
}

function stripTrailingSubmit(value: string): string {
  return value.replace(/[\r\n]+$/g, "");
}
