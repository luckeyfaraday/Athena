// App-wide keyboard shortcuts. They are caught in the capture phase before
// xterm sees the key, so every binding here is one terminals and agent TUIs
// don't use (no bare Ctrl+letter: Ctrl+K, Ctrl+R, Ctrl+T... belong to them).
// "Mod" is Cmd on macOS and Ctrl elsewhere.

export type ShortcutId =
  | "palette"
  | "settings"
  | "newShell"
  | "launchAgent"
  | "nextWorkspace"
  | "previousWorkspace"
  | "workspace1"
  | "workspace2"
  | "workspace3"
  | "workspace4"
  | "workspace5"
  | "workspace6"
  | "workspace7"
  | "workspace8"
  | "workspace9"
  | "toggleSessions"
  | "toggleInterfaceMode";

export type ShortcutSpec = {
  // KeyboardEvent.code, so bindings survive Shift and non-US layouts.
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  // Physical Ctrl on every platform (Ctrl+Tab stays Ctrl+Tab on macOS).
  ctrl?: boolean;
};

export type ShortcutDefinition = { id: ShortcutId; spec: ShortcutSpec; label: string; hidden?: boolean };

const workspaceDigits = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  { id: "palette", spec: { code: "KeyP", mod: true, shift: true }, label: "Open the command palette" },
  { id: "settings", spec: { code: "Comma", mod: true }, label: "Open Settings" },
  { id: "newShell", spec: { code: "KeyT", mod: true, shift: true }, label: "New shell" },
  { id: "launchAgent", spec: { code: "KeyN", mod: true, shift: true }, label: "Launch an agent" },
  { id: "toggleSessions", spec: { code: "KeyS", mod: true, shift: true }, label: "Switch Terminals / Sessions" },
  { id: "toggleInterfaceMode", spec: { code: "KeyM", mod: true, shift: true }, label: "Switch terminal / chat view" },
  { id: "nextWorkspace", spec: { code: "Tab", ctrl: true }, label: "Next workspace" },
  { id: "previousWorkspace", spec: { code: "Tab", ctrl: true, shift: true }, label: "Previous workspace" },
  ...workspaceDigits.map((digit) => ({
    id: `workspace${digit}` as ShortcutId,
    spec: { code: `Digit${digit}`, mod: true },
    label: `Go to workspace ${digit}`,
    hidden: digit > 1,
  })),
];

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac/i.test(platform) || /Mac OS X/.test(navigator.userAgent ?? "");
}

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

export function matchesShortcut(event: KeyLike, spec: ShortcutSpec, mac = isMacPlatform()): boolean {
  if (event.code !== spec.code) return false;
  const wantCtrl = Boolean(spec.ctrl || (spec.mod && !mac));
  const wantMeta = Boolean(spec.mod && mac);
  return event.ctrlKey === wantCtrl
    && event.metaKey === wantMeta
    && event.shiftKey === Boolean(spec.shift)
    && event.altKey === Boolean(spec.alt);
}

export function matchShortcut(event: KeyLike, mac = isMacPlatform()): ShortcutId | null {
  return shortcutDefinitions.find((definition) => matchesShortcut(event, definition.spec, mac))?.id ?? null;
}

const codeLabels: Record<string, string> = {
  Comma: ",",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
  BracketLeft: "[",
  BracketRight: "]",
};

function codeLabel(code: string): string {
  if (codeLabels[code]) return codeLabels[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

// Key caps for display, e.g. ["Ctrl", "Shift", "P"] or ["⌘", "⇧", "P"].
export function shortcutKeys(spec: ShortcutSpec, mac = isMacPlatform()): string[] {
  const keys: string[] = [];
  if (spec.ctrl) keys.push(mac ? "⌃" : "Ctrl");
  if (spec.mod) keys.push(mac ? "⌘" : "Ctrl");
  if (spec.alt) keys.push(mac ? "⌥" : "Alt");
  if (spec.shift) keys.push(mac ? "⇧" : "Shift");
  keys.push(codeLabel(spec.code));
  return keys;
}

export function shortcutKeysFor(id: ShortcutId, mac = isMacPlatform()): string[] {
  const definition = shortcutDefinitions.find((item) => item.id === id);
  return definition ? shortcutKeys(definition.spec, mac) : [];
}

// Visible reference list (Settings, palette help): one "Ctrl+1…9" row instead of nine.
export function shortcutReference(mac = isMacPlatform()): Array<{ id: ShortcutId; label: string; keys: string[] }> {
  return shortcutDefinitions
    .filter((definition) => !definition.hidden)
    .map((definition) => definition.id === "workspace1"
      ? { id: definition.id, label: "Go to workspace 1–9", keys: [...shortcutKeys(definition.spec, mac).slice(0, -1), "1…9"] }
      : { id: definition.id, label: definition.label, keys: shortcutKeys(definition.spec, mac) });
}
