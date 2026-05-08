import assert from "node:assert/strict";
import test from "node:test";

import {
  commandLookupTool,
  isPosixPath,
  isWindowsPath,
  isWslPath,
  scriptExtensionForPlatform,
  toWorkspacePath,
  windowsPathToWslPath,
  windowsTerminalGridArgs,
  wslPathToWindowsPath,
} from "../dist-electron/platform.js";

test("detects common Windows, POSIX, and WSL path forms", () => {
  assert.equal(isWindowsPath("C:\\Users\\dev\\repo"), true);
  assert.equal(isWindowsPath("/home/dev/repo"), false);
  assert.equal(isPosixPath("/home/dev/repo"), true);
  assert.equal(isWslPath("/mnt/c/Users/dev/repo"), true);
});

test("converts Windows drive paths to WSL paths and back", () => {
  assert.equal(windowsPathToWslPath("C:\\Users\\dev\\repo"), "/mnt/c/Users/dev/repo");
  assert.equal(wslPathToWindowsPath("/mnt/c/Users/dev/repo"), "C:\\Users\\dev\\repo");
});

test("keeps Windows workspace paths first-class in the workspace model", () => {
  const workspace = toWorkspacePath("C:\\Users\\dev\\repo");
  assert.equal(workspace.nativePath, "C:\\Users\\dev\\repo");
  assert.equal(workspace.wslPath, "/mnt/c/Users/dev/repo");
  assert.equal(workspace.displayPath, "C:\\Users\\dev\\repo");
});

test("selects platform-specific command lookup and script conventions", () => {
  assert.equal(commandLookupTool("win32"), "where.exe");
  assert.equal(commandLookupTool("linux"), "which");
  assert.equal(commandLookupTool("darwin"), "which");
  assert.equal(scriptExtensionForPlatform("win32"), ".ps1");
  assert.equal(scriptExtensionForPlatform("linux"), ".sh");
});

test("generates Windows Terminal split-pane arguments", () => {
  const args = windowsTerminalGridArgs("C:\\Users\\dev\\repo", ["a.ps1", "b.ps1"]);
  assert.deepEqual(args.slice(0, 9), ["-d", "C:\\Users\\dev\\repo", "powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "a.ps1"]);
  assert.equal(args.includes("split-pane"), true);
  assert.equal(args.at(-1), "b.ps1");
});
