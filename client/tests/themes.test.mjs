import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { themeWindowBackground, themeWindowBackgrounds } from "../electron/theme-window.ts";
import {
  isThemeId,
  nextTheme,
  parseThemePreference,
  resolveTheme,
  systemThemes,
  themeIds,
  themeLabel,
  themes,
} from "../src/themes.ts";

// Normalize line endings: Windows checkouts (core.autocrlf) are CRLF, CI is LF.
const readCss = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tokensCss = readCss("../src/styles/tokens.css");
const themesCss = readCss("../src/styles/themes.css");

const paletteTokens = [
  "--bg", "--surface-1", "--surface-2", "--surface-3", "--surface-sunken", "--surface-overlay", "--terminal",
  "--border", "--border-strong", "--text", "--text-2", "--text-muted", "--text-faint",
  "--accent", "--accent-fg", "--ok", "--warn", "--danger", "--info",
];
const ansiTokens = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
  .flatMap((color) => [`--ansi-${color}`, `--ansi-bright-${color}`]);

function declarations(block) {
  const map = new Map();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map.set(match[1], match[2].trim());
  return map;
}

function baseBlock() {
  const start = tokensCss.indexOf(":root,\n[data-theme] {");
  assert.ok(start >= 0, "tokens.css declares the base token block on :root and [data-theme]");
  return declarations(tokensCss.slice(start, tokensCss.indexOf("\n}\n", start)));
}

function themeBlock(id) {
  const start = themesCss.indexOf(`[data-theme="${id}"] {`);
  if (start < 0) return null;
  return declarations(themesCss.slice(start, themesCss.indexOf("\n}\n", start)));
}

// Effective tokens for a theme: classic defaults overlaid by the theme block.
function themeTokens(id) {
  const tokens = new Map(baseBlock());
  for (const [name, value] of themeBlock(id) ?? []) tokens.set(name, value);
  return tokens;
}

function hexToRgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (!hex) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance([red, green, blue]) {
  const channel = (value) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground, background) {
  const a = hexToRgb(foreground);
  const b = hexToRgb(background);
  assert.ok(a && b, `expected solid hex colors, got ${foreground} on ${background}`);
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test("every registered theme has a token block, and every block is registered", () => {
  for (const id of themeIds) {
    if (id === "classic") continue;
    assert.ok(themeBlock(id), `themes.css is missing [data-theme="${id}"]`);
  }
  for (const match of themesCss.matchAll(/\[data-theme="([a-z-]+)"\]/g)) {
    assert.ok(isThemeId(match[1]), `themes.css styles unregistered theme "${match[1]}"`);
  }
  assert.deepEqual(themes.map((theme) => theme.id), [...themeIds]);
});

test("every theme defines the full palette and 16-color terminal palette", () => {
  for (const token of [...paletteTokens, ...ansiTokens]) {
    assert.ok(baseBlock().has(token), `tokens.css base is missing ${token}`);
  }
  for (const id of themeIds) {
    if (id === "classic") continue;
    const block = themeBlock(id);
    for (const token of [...paletteTokens, ...ansiTokens]) {
      assert.ok(block.has(token), `${id} does not define ${token} (it would inherit Classic's inside a preview card)`);
    }
  }
});

test("native window backgrounds match each theme's --bg", () => {
  assert.deepEqual(Object.keys(themeWindowBackgrounds).sort(), [...themeIds].sort());
  for (const id of themeIds) {
    assert.equal(themeTokens(id).get("--bg").toLowerCase(), themeWindowBackgrounds[id], `${id} window background`);
  }
  assert.equal(themeWindowBackground("system", true), themeWindowBackgrounds[systemThemes.dark]);
  assert.equal(themeWindowBackground("system", false), themeWindowBackgrounds[systemThemes.light]);
  assert.equal(themeWindowBackground("not-a-theme", true), themeWindowBackgrounds.classic);
  assert.equal(themeWindowBackground(undefined, true), themeWindowBackgrounds.classic);
});

test("text meets WCAG contrast in every theme", () => {
  for (const id of themeIds) {
    const tokens = themeTokens(id);
    for (const surface of ["--bg", "--surface-1", "--surface-2", "--surface-overlay"]) {
      assert.ok(contrast(tokens.get("--text"), tokens.get(surface)) >= 7, `${id}: --text on ${surface}`);
      assert.ok(contrast(tokens.get("--text-2"), tokens.get(surface)) >= 4.5, `${id}: --text-2 on ${surface}`);
    }
    for (const surface of ["--bg", "--surface-1"]) {
      const ratio = contrast(tokens.get("--text-muted"), tokens.get(surface));
      assert.ok(ratio >= 4.5, `${id}: --text-muted on ${surface} is ${ratio.toFixed(2)}`);
    }
    const accentRatio = contrast(tokens.get("--accent-fg"), tokens.get("--accent"));
    assert.ok(accentRatio >= 4.5, `${id}: --accent-fg on --accent is ${accentRatio.toFixed(2)}`);
    const terminalRatio = contrast(tokens.get("--text"), tokens.get("--terminal"));
    assert.ok(terminalRatio >= 7, `${id}: terminal foreground is ${terminalRatio.toFixed(2)}`);
  }
});

test("status and terminal colors stay readable on their backgrounds", () => {
  for (const id of themeIds) {
    const tokens = themeTokens(id);
    for (const status of ["--ok", "--warn", "--danger", "--info", "--accent"]) {
      const ratio = contrast(tokens.get(status), tokens.get("--surface-1"));
      assert.ok(ratio >= 3, `${id}: ${status} on --surface-1 is ${ratio.toFixed(2)}`);
    }
    for (const color of ["red", "green", "yellow", "blue", "magenta", "cyan"]) {
      const ratio = contrast(tokens.get(`--ansi-${color}`), tokens.get("--terminal"));
      assert.ok(ratio >= 3, `${id}: --ansi-${color} on the terminal is ${ratio.toFixed(2)}`);
    }
  }
});

test("theme preferences parse, resolve and cycle", () => {
  assert.equal(parseThemePreference("system"), "system");
  assert.equal(parseThemePreference("dusk"), "dusk");
  assert.equal(parseThemePreference("mono-light"), "mono-light");
  assert.equal(parseThemePreference("Dusk"), null);
  assert.equal(parseThemePreference(""), null);
  assert.equal(parseThemePreference(null), null);
  assert.equal(resolveTheme("system", true), "daylight");
  assert.equal(resolveTheme("system", false), "classic");
  assert.equal(resolveTheme("neon", true), "neon");
  assert.equal(themeLabel("system"), "Match system");
  assert.equal(themeLabel("contrast"), "High Contrast");
  assert.equal(nextTheme(themeIds.at(-1)), themeIds[0]);
  assert.equal(nextTheme(themeIds[0], -1), themeIds.at(-1));
});
