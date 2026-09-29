// Native window background for each UI theme. Electron paints it before the
// renderer's first frame and while the window resizes, so matching the
// theme's --bg avoids a flash of the wrong color (most visible on light
// themes). Mirrors --bg in client/src/styles/themes.css; a test keeps them in sync.

export const THEME_PREFERENCE_KEY = "context-workspace:uiTheme";

export const themeWindowBackgrounds: Readonly<Record<string, string>> = {
  classic: "#0b1712",
  daylight: "#ebe5d7",
  nightfall: "#0b0e17",
  fjord: "#20242d",
  dusk: "#16111a",
  ember: "#121110",
  neon: "#0d0a1a",
  solstice: "#00212b",
  monolith: "#07070b",
  press: "#0c0a07",
  "mono-dark": "#0a0a0a",
  "mono-light": "#f3f3f3",
  contrast: "#000000",
};

export function themeWindowBackground(preference: string | null | undefined, systemPrefersDark: boolean): string {
  if (preference === "system") return systemPrefersDark ? themeWindowBackgrounds.classic : themeWindowBackgrounds.daylight;
  return (preference && themeWindowBackgrounds[preference]) || themeWindowBackgrounds.classic;
}
