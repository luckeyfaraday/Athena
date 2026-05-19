export const CODEX_INPUT_SUBMIT_DELAY_MS = 250;

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export type TerminalInputWrite = {
  data: string;
  delayAfterMs?: number;
};

export function terminalInputWritesForKind(kind: string, text: string): TerminalInputWrite[] {
  const prompt = stripTrailingSubmit(text);
  if (!prompt) return [{ data: "\r" }];

  if (kind !== "codex") return [{ data: `${prompt}\r` }];

  return [
    { data: `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`, delayAfterMs: CODEX_INPUT_SUBMIT_DELAY_MS },
    { data: "\r" },
  ];
}

function stripTrailingSubmit(value: string): string {
  return value.replace(/[\r\n]+$/g, "");
}
