import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_TERMINAL_PANE_HEIGHT,
  clampTerminalPaneHeight,
  reconcileTerminalPaneHeights,
  terminalFocusAfterCollapse,
} from "../src/pane-layout.ts";

test("pane height clamps to the visible stage", () => {
  assert.equal(clampTerminalPaneHeight(50, 900), MIN_TERMINAL_PANE_HEIGHT);
  assert.equal(clampTerminalPaneHeight(480, 900), 480);
  assert.equal(clampTerminalPaneHeight(1_200, 900), 900);
});

test("pane-set changes reset React-owned manual heights", () => {
  const current = { first: 380, second: 410 };
  assert.deepEqual(reconcileTerminalPaneHeights(current, ["first", "second", "third"], true), {});
});

test("ordinary rerenders preserve known pane heights and prune closed panes", () => {
  const current = { first: 380, closed: 410 };
  assert.deepEqual(reconcileTerminalPaneHeights(current, ["first"], false), { first: 380 });
  const stable = { first: 380 };
  assert.equal(reconcileTerminalPaneHeights(stable, ["first"], false), stable);
});

test("collapsing the focused pane hands focus to a visible sibling", () => {
  assert.equal(terminalFocusAfterCollapse("second", "second", ["first", "second", "third"], new Set()), "third");
  assert.equal(terminalFocusAfterCollapse("third", "third", ["first", "second", "third"], new Set(["first"])), "second");
  assert.equal(terminalFocusAfterCollapse("only", "only", ["only"], new Set()), null);
  assert.equal(terminalFocusAfterCollapse("second", "first", ["first", "second"], new Set()), "first");
});
