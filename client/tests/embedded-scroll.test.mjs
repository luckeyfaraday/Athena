import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_SCROLL_STICK_THRESHOLD_PX, isNearScrollBottom, terminalUsesMouseWheelProtocol } from "../src/embedded-scroll.ts";

test("isNearScrollBottom returns true when the viewport is pinned to the bottom", () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 500, scrollTop: 420, clientHeight: 80 }), true);
  assert.equal(isNearScrollBottom({ scrollHeight: 500, scrollTop: 420, clientHeight: 80 }, 0), true);
});

test("isNearScrollBottom returns false when the user has scrolled up", () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 500, scrollTop: 100, clientHeight: 80 }), false);
});

test("isNearScrollBottom honors the stick threshold", () => {
  const threshold = CHAT_SCROLL_STICK_THRESHOLD_PX;
  const element = { scrollHeight: 500, clientHeight: 80 };
  assert.equal(isNearScrollBottom({ ...element, scrollTop: 500 - 80 - threshold }), true);
  assert.equal(isNearScrollBottom({ ...element, scrollTop: 500 - 80 - threshold - 1 }), false);
});

test("terminalUsesMouseWheelProtocol detects xterm mouse-tracking mode", () => {
  const container = {
    querySelector(selector) {
      return selector === ".xterm.enable-mouse-events" ? {} : null;
    },
  };
  assert.equal(terminalUsesMouseWheelProtocol(container), true);
  assert.equal(terminalUsesMouseWheelProtocol({ querySelector: () => null }), false);
  assert.equal(terminalUsesMouseWheelProtocol(null), false);
});