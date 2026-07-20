import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_TERMINAL_PANE_HEIGHT,
  clampTerminalPaneHeight,
  reconcileTerminalPaneHeights,
  terminalFocusAfterCollapse,
} from "../../src/pane-layout.ts";

test("PR #57/#146/#189: pane-set reflow resets browser-independent manual sizing", () => {
  assert.deepEqual(reconcileTerminalPaneHeights({ first: 360 }, ["first", "second"], true), {});
});

test("PR #189: manual pane sizing is bounded by the visible stage", () => {
  assert.equal(clampTerminalPaneHeight(1, 800), MIN_TERMINAL_PANE_HEIGHT);
  assert.equal(clampTerminalPaneHeight(2_000, 800), 800);
});

test("PR #146/#179: collapsing the focus owner promotes a mounted sibling", () => {
  assert.equal(terminalFocusAfterCollapse("a", "a", ["a", "b"], new Set()), "b");
});
