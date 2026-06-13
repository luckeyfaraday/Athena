import assert from "node:assert/strict";
import test from "node:test";

import { resolveUpdateMode } from "../dist-electron/update-mode.js";

test("resolveUpdateMode disables updates in dev builds on every platform", () => {
  assert.equal(resolveUpdateMode("linux", false), "disabled");
  assert.equal(resolveUpdateMode("win32", false), "disabled");
  assert.equal(resolveUpdateMode("darwin", false), "disabled");
});

test("resolveUpdateMode auto-installs on Linux and Windows", () => {
  assert.equal(resolveUpdateMode("linux", true), "auto-install");
  assert.equal(resolveUpdateMode("win32", true), "auto-install");
});

test("resolveUpdateMode only notifies on macOS (unsigned builds cannot self-install)", () => {
  assert.equal(resolveUpdateMode("darwin", true), "notify-only");
});
