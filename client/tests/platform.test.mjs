import assert from "node:assert/strict";
import test from "node:test";

import {
  commandLookupTool,
  isPosixPath,
  isWindowsPath,
  isWslPath,
  normalizeComparablePath,
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
