import assert from "node:assert/strict";
import test from "node:test";

import {
  commandLookupTool,
  isPosixPath,
  isWindowsPath,
  isWslPath,
  normalizeComparablePath,
  preferredWindowsPowerShell,
  toWorkspacePath,
  windowsPathToWslPath,
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

test("normalizes equivalent Windows and WSL workspace keys", () => {
  assert.equal(normalizeComparablePath("C:\\Users\\dev\\repo\\"), "c:/users/dev/repo");
  assert.equal(normalizeComparablePath("/mnt/c/Users/dev/repo"), "c:/users/dev/repo");
  assert.equal(normalizeComparablePath("/C:/Users/dev/repo"), "c:/users/dev/repo");
});

test("preserves filesystem roots in comparable paths", () => {
  assert.equal(normalizeComparablePath("/"), "/");
  assert.equal(normalizeComparablePath("///"), "/");
  assert.equal(normalizeComparablePath("C:\\"), "c:/");
  assert.equal(normalizeComparablePath("/mnt/C/"), "c:/");
  assert.equal(normalizeComparablePath("\\\\Server\\Share\\"), "//server/share");
});

test("preserves POSIX path case when normalizing comparable paths", () => {
  assert.equal(normalizeComparablePath("/home/dev/Repo"), "/home/dev/Repo");
  assert.notEqual(normalizeComparablePath("/home/dev/Repo"), normalizeComparablePath("/home/dev/repo"));
});

test("normalizes UNC paths with Windows case semantics", () => {
  assert.equal(normalizeComparablePath("\\\\Server\\Share\\Repo"), "//server/share/repo");
  assert.equal(
    normalizeComparablePath("\\\\SERVER\\SHARE\\REPO"),
    normalizeComparablePath("\\\\server\\share\\repo"),
  );
});

test("keeps Windows workspace paths first-class in the workspace model", () => {
  const workspace = toWorkspacePath("C:\\Users\\dev\\repo");
  assert.equal(workspace.nativePath, "C:\\Users\\dev\\repo");
  assert.equal(workspace.wslPath, "/mnt/c/Users/dev/repo");
  assert.equal(workspace.displayPath, "C:\\Users\\dev\\repo");
});

test("selects the platform-specific command lookup tool", () => {
  assert.equal(commandLookupTool("win32"), "where.exe");
  assert.equal(commandLookupTool("linux"), "which");
  assert.equal(commandLookupTool("darwin"), "which");
});

test("prefers PowerShell 7 on Windows and falls back to Windows PowerShell", () => {
  assert.equal(preferredWindowsPowerShell((command) => command === "pwsh.exe"), "pwsh.exe");
  assert.equal(preferredWindowsPowerShell(() => false), "powershell.exe");
});

test("memoizes the default PowerShell PATH probe for the process lifetime", () => {
  const first = preferredWindowsPowerShell();
  assert.ok(first === "pwsh.exe" || first === "powershell.exe");
  // An injected probe is never cached and never poisons the default cache.
  const flipped = preferredWindowsPowerShell(() => first !== "pwsh.exe");
  assert.notEqual(flipped, first);
  const started = process.hrtime.bigint();
  for (let index = 0; index < 50; index += 1) assert.equal(preferredWindowsPowerShell(), first);
  // Fifty uncached where.exe/which spawns would take whole seconds.
  assert.ok(process.hrtime.bigint() - started < 50_000_000n);
});
