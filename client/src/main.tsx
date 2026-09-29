import React from "react";
import { createRoot } from "react-dom/client";
// Fonts ship with the app: no network fetch at launch, and they work offline.
// Each @font-face only downloads when a theme actually uses that family.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
// Shared styles load before App so room and component stylesheets can build on them.
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles.css";
import { App } from "./App";
import {
  defaultTerminalAppearance,
  parseTerminalFont,
  parseTerminalFontSize,
  terminalFontFamily,
  terminalFontSizeStorageKey,
  terminalFontStorageKey,
} from "./terminal-appearance";

// Start loading the saved terminal font now, so panes restored at launch find
// it ready instead of waiting on it before their first paint.
try {
  const font = parseTerminalFont(localStorage.getItem(terminalFontStorageKey)) ?? defaultTerminalAppearance.font;
  const size = parseTerminalFontSize(localStorage.getItem(terminalFontSizeStorageKey)) ?? defaultTerminalAppearance.fontSize;
  const family = terminalFontFamily(font).split(",")[0]?.trim();
  if (family && typeof document.fonts?.load === "function") void document.fonts.load(`${size}px ${family}`).catch(() => undefined);
} catch {
  // Storage unavailable: panes load the font themselves.
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
