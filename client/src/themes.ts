// Theme registry. The colors live in styles/themes.css as token blocks keyed by
// [data-theme]; this file only names them, groups them for the gallery, and
// resolves the "system" preference. Keep ids in sync with themes.css and
// electron/theme-window.ts.

export const themeIds = [
  "classic",
  "daylight",
  "nightfall",
  "fjord",
  "dusk",
  "ember",
  "neon",
  "solstice",
  "monolith",
  "press",
  "mono-dark",
  "mono-light",
  "contrast",
] as const;

export type ThemeId = (typeof themeIds)[number];
export type ThemePreference = ThemeId | "system";
export type ThemeAppearance = "dark" | "light";

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  description: string;
  appearance: ThemeAppearance;
};

export const themes: readonly ThemeDefinition[] = [
  { id: "classic", label: "Classic", appearance: "dark", description: "Athena's forest green with a gold signal. The original." },
  { id: "daylight", label: "Daylight", appearance: "light", description: "Warm paper and forest ink. Athena in daylight." },
  { id: "nightfall", label: "Nightfall", appearance: "dark", description: "Deep navy with an electric blue edge." },
  { id: "fjord", label: "Fjord", appearance: "dark", description: "Arctic slate and glacier cyan. Soft and calm." },
  { id: "dusk", label: "Dusk", appearance: "dark", description: "Plum night lit with rose and lavender." },
  { id: "ember", label: "Ember", appearance: "dark", description: "Charcoal and forge orange for long sessions." },
  { id: "neon", label: "Neon", appearance: "dark", description: "Synthwave violet, hot pink, and cyan glow." },
  { id: "solstice", label: "Solstice", appearance: "dark", description: "Solarized depths with sunlit cream text." },
  { id: "monolith", label: "Monolith", appearance: "dark", description: "Void black, acid lime, and hard edges." },
  { id: "press", label: "Press", appearance: "dark", description: "Warm editorial ink, serif headings, vermillion." },
  { id: "mono-dark", label: "Mono Dark", appearance: "dark", description: "Pure graphite. White is the only accent." },
  { id: "mono-light", label: "Mono Light", appearance: "light", description: "Paper white. Black is the only accent." },
  { id: "contrast", label: "High Contrast", appearance: "dark", description: "Pure black, bright text, signal yellow. Built for legibility." },
];

// What "Match system" resolves to.
export const systemThemes: Record<ThemeAppearance, ThemeId> = { dark: "classic", light: "daylight" };

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (themeIds as readonly string[]).includes(value);
}

export function parseThemePreference(value: string | null | undefined): ThemePreference | null {
  if (value === "system") return "system";
  return isThemeId(value) ? value : null;
}

export function resolveTheme(preference: ThemePreference, systemPrefersLight: boolean): ThemeId {
  if (preference === "system") return systemThemes[systemPrefersLight ? "light" : "dark"];
  return preference;
}

export function themeDefinition(id: ThemeId): ThemeDefinition {
  return themes.find((theme) => theme.id === id) ?? themes[0];
}

export function themeLabel(preference: ThemePreference): string {
  return preference === "system" ? "Match system" : themeDefinition(preference).label;
}

// Cycle for the palette's "next theme" command and keyboard shortcut.
export function nextTheme(current: ThemeId, direction: 1 | -1 = 1): ThemeId {
  const index = themeIds.indexOf(current);
  return themeIds[(index + direction + themeIds.length) % themeIds.length];
}
