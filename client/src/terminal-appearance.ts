// Terminal text settings shared by every live xterm pane. Panes subscribe and
// apply changes in place (font options + refit) instead of remounting.

export type TerminalFontId = "jetbrains" | "cascadia" | "system";

export type TerminalAppearance = {
  font: TerminalFontId;
  fontSize: number;
};

export const terminalFontStorageKey = "context-workspace:terminalFont";
export const terminalFontSizeStorageKey = "context-workspace:terminalFontSize";

export const minTerminalFontSize = 9;
export const maxTerminalFontSize = 22;
export const defaultTerminalAppearance: TerminalAppearance = { font: "jetbrains", fontSize: 12 };

export const terminalFonts: ReadonlyArray<{ id: TerminalFontId; label: string; family: string; detail: string }> = [
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    family: "'JetBrains Mono Variable', 'Cascadia Mono', Consolas, monospace",
    detail: "Bundled with Athena. Looks the same on every platform.",
  },
  {
    id: "cascadia",
    label: "Cascadia Mono",
    family: "'Cascadia Mono', 'Cascadia Code', Consolas, 'JetBrains Mono Variable', monospace",
    detail: "The Windows Terminal font, when installed.",
  },
  {
    id: "system",
    label: "System",
    family: "ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
    detail: "Your operating system's monospace font.",
  },
];

export function parseTerminalFont(value: string | null | undefined): TerminalFontId | null {
  return value === "jetbrains" || value === "cascadia" || value === "system" ? value : null;
}

export function parseTerminalFontSize(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clampTerminalFontSize(parsed);
}

export function clampTerminalFontSize(value: number): number {
  return Math.min(maxTerminalFontSize, Math.max(minTerminalFontSize, Math.round(value)));
}

export function terminalFontFamily(font: TerminalFontId): string {
  return (terminalFonts.find((item) => item.id === font) ?? terminalFonts[0]).family;
}

let current: TerminalAppearance = defaultTerminalAppearance;
const listeners = new Set<(appearance: TerminalAppearance) => void>();

export function getTerminalAppearance(): TerminalAppearance {
  return current;
}

export function setTerminalAppearance(next: TerminalAppearance): void {
  const normalized = { font: next.font, fontSize: clampTerminalFontSize(next.fontSize) };
  if (normalized.font === current.font && normalized.fontSize === current.fontSize) return;
  current = normalized;
  for (const listener of listeners) listener(current);
}

export function subscribeTerminalAppearance(listener: (appearance: TerminalAppearance) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
