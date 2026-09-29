// Recently run command-palette commands, newest first. Stored per machine in
// localStorage; ids that no longer exist are skipped when displayed, so the
// stored list keeps more than the palette shows.

export const paletteRecentsStorageKey = "context-workspace:paletteRecents";
export const maxDisplayedPaletteRecents = 5;
const maxStoredPaletteRecents = 20;

export function pushRecent(recents: readonly string[], id: string, max = maxStoredPaletteRecents): string[] {
  return [id, ...recents.filter((item) => item !== id)].slice(0, max);
}

export function parseRecents(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, maxStoredPaletteRecents);
  } catch {
    return [];
  }
}

export function readPaletteRecents(): string[] {
  try {
    return parseRecents(globalThis.localStorage?.getItem(paletteRecentsStorageKey) ?? null);
  } catch {
    return [];
  }
}

export function recordPaletteRecent(id: string): string[] {
  const next = pushRecent(readPaletteRecents(), id);
  try {
    globalThis.localStorage?.setItem(paletteRecentsStorageKey, JSON.stringify(next));
  } catch {
    // Recents are a convenience; ignore storage failures.
  }
  return next;
}
