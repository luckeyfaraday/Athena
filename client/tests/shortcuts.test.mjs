import assert from "node:assert/strict";
import test from "node:test";

import { matchShortcut, matchesShortcut, shortcutDefinitions, shortcutKeys, shortcutReference } from "../src/shortcuts.ts";
import {
  clampTerminalFontSize,
  getTerminalAppearance,
  maxTerminalFontSize,
  minTerminalFontSize,
  parseTerminalFont,
  parseTerminalFontSize,
  setTerminalAppearance,
  subscribeTerminalAppearance,
  terminalFontFamily,
} from "../src/terminal-appearance.ts";

const key = (code, modifiers = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

test("Mod means Ctrl on Windows/Linux and Cmd on macOS", () => {
  assert.equal(matchShortcut(key("KeyP", { ctrlKey: true, shiftKey: true }), false), "palette");
  assert.equal(matchShortcut(key("KeyP", { metaKey: true, shiftKey: true }), true), "palette");
  assert.equal(matchShortcut(key("KeyP", { metaKey: true, shiftKey: true }), false), null);
  assert.equal(matchShortcut(key("KeyP", { ctrlKey: true, shiftKey: true }), true), null);
});

test("extra or missing modifiers never match, so terminal keys pass through", () => {
  // Ctrl+P, Ctrl+K, Ctrl+R, Ctrl+T and friends belong to shells and agent TUIs.
  for (const code of ["KeyP", "KeyK", "KeyR", "KeyT", "KeyC", "KeyD", "KeyL"]) {
    assert.equal(matchShortcut(key(code, { ctrlKey: true }), false), null, `Ctrl+${code}`);
  }
  assert.equal(matchShortcut(key("KeyP", { ctrlKey: true, shiftKey: true, altKey: true }), false), null);
  assert.equal(matchShortcut(key("Tab"), false), null, "plain Tab reaches the terminal");
  assert.equal(matchShortcut(key("Escape"), false), null);
});

test("Ctrl+Tab cycles workspaces on every platform", () => {
  for (const mac of [false, true]) {
    assert.equal(matchShortcut(key("Tab", { ctrlKey: true }), mac), "nextWorkspace");
    assert.equal(matchShortcut(key("Tab", { ctrlKey: true, shiftKey: true }), mac), "previousWorkspace");
  }
});

test("Mod+digit jumps to a workspace; bindings are unique", () => {
  assert.equal(matchShortcut(key("Digit1", { ctrlKey: true }), false), "workspace1");
  assert.equal(matchShortcut(key("Digit9", { metaKey: true }), true), "workspace9");
  const specs = shortcutDefinitions.map(({ spec }) => JSON.stringify([spec.code, !!spec.mod, !!spec.ctrl, !!spec.shift, !!spec.alt]));
  assert.equal(new Set(specs).size, specs.length, "no two shortcuts share a binding");
  assert.ok(matchesShortcut(key("Comma", { ctrlKey: true }), { code: "Comma", mod: true }, false));
});

test("key caps and the reference list read naturally", () => {
  assert.deepEqual(shortcutKeys({ code: "KeyP", mod: true, shift: true }, false), ["Ctrl", "Shift", "P"]);
  assert.deepEqual(shortcutKeys({ code: "KeyP", mod: true, shift: true }, true), ["⌘", "⇧", "P"]);
  assert.deepEqual(shortcutKeys({ code: "Comma", mod: true }, false), ["Ctrl", ","]);
  const reference = shortcutReference(false);
  assert.equal(reference.filter((row) => row.id.startsWith("workspace")).length, 1, "digits collapse to one row");
  assert.deepEqual(reference.find((row) => row.id === "workspace1").keys, ["Ctrl", "1…9"]);
});

test("terminal text preferences parse and clamp", () => {
  assert.equal(parseTerminalFont("cascadia"), "cascadia");
  assert.equal(parseTerminalFont("comic-sans"), null);
  assert.equal(parseTerminalFont(null), null);
  assert.equal(parseTerminalFontSize("14"), 14);
  assert.equal(parseTerminalFontSize("13.6"), 14);
  assert.equal(parseTerminalFontSize("200"), maxTerminalFontSize);
  assert.equal(parseTerminalFontSize("1"), minTerminalFontSize);
  assert.equal(parseTerminalFontSize("big"), null);
  assert.equal(parseTerminalFontSize(""), null);
  assert.equal(clampTerminalFontSize(12.4), 12);
  assert.match(terminalFontFamily("jetbrains"), /JetBrains Mono Variable/);
  assert.match(terminalFontFamily("system"), /monospace$/);
});

test("terminal appearance changes reach subscribers once", () => {
  const seen = [];
  const unsubscribe = subscribeTerminalAppearance((appearance) => seen.push(appearance));
  const start = getTerminalAppearance();
  setTerminalAppearance({ font: "system", fontSize: 15 });
  setTerminalAppearance({ font: "system", fontSize: 15 });
  setTerminalAppearance({ font: "system", fontSize: 99 });
  unsubscribe();
  setTerminalAppearance(start);
  assert.deepEqual(seen, [{ font: "system", fontSize: 15 }, { font: "system", fontSize: maxTerminalFontSize }]);
});
