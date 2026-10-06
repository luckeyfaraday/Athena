import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listDirectories } from "../dist-electron/remote-fs.js";
import { onReportedWorkspaces, reportedWorkspaces, reportWorkspaces } from "../dist-electron/workspace-registry.js";

function tree() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "athena-dirs-")));
  for (const dir of ["beta", "Alpha", "project10", "project9", ".hidden"]) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "notes.txt"), "not a folder");
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(root, "beta"), path.join(root, "linked"));
    fs.symlinkSync(path.join(root, "notes.txt"), path.join(root, "linked-file"));
  }
  return root;
}

test("listDirectories lists folders only, sorted naturally, hiding dot-folders", async () => {
  const root = tree();
  try {
    const listing = await listDirectories(root, { home: root });
    const names = listing.dirs.map((entry) => entry.name);
    const expected = ["Alpha", "beta", ...(process.platform === "win32" ? [] : ["linked"]), "project9", "project10"];
    assert.deepEqual(names, expected);
    assert.equal(listing.path, root);
    assert.equal(listing.parent, path.dirname(root));
    assert.equal(listing.truncated, false);
    assert.equal(listing.dirs[0].path, path.join(root, "Alpha"));
    const withHidden = await listDirectories(root, { includeHidden: true, home: root });
    assert.ok(withHidden.dirs.some((entry) => entry.name === ".hidden"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listDirectories defaults to home, truncates, and reports the root's parent as null", async () => {
  const root = tree();
  try {
    const home = await listDirectories(undefined, { home: root });
    assert.equal(home.path, root);
    const limited = await listDirectories(root, { home: root, limit: 2 });
    assert.equal(limited.dirs.length, 2);
    assert.equal(limited.truncated, true);
    const top = await listDirectories(path.parse(root).root, { home: root });
    assert.equal(top.parent, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listDirectories refuses URLs, relative paths, UNC paths, files, and missing folders", async () => {
  const root = tree();
  try {
    await assert.rejects(listDirectories("http://evil.example/x"), /not a URL/);
    await assert.rejects(listDirectories("relative/path"), /absolute path/);
    await assert.rejects(listDirectories("\\\\server\\share"), /UNC/);
    await assert.rejects(listDirectories(path.join(root, "notes.txt")), /Not a folder/);
    await assert.rejects(listDirectories(path.join(root, "missing")), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reportWorkspaces keeps valid, unique tabs and notifies only on change", () => {
  const seen = [];
  const app = path.resolve("workspace-fixture", "app");
  const api = path.resolve("workspace-fixture", "api");
  const remove = onReportedWorkspaces((state) => seen.push(state));
  try {
    const state = reportWorkspaces([app, app, "", 42, api], api);
    assert.deepEqual(state.workspaces.map((item) => item.nativePath), [app, api]);
    assert.equal(state.active.nativePath, api);
    assert.equal(reportedWorkspaces(), state);
    reportWorkspaces([app, api], api);
    assert.equal(seen.length, 1, "an identical report is not a change");
    reportWorkspaces("nonsense", null);
    assert.deepEqual(reportedWorkspaces(), { workspaces: [], active: null });
    assert.equal(seen.length, 2);
  } finally {
    remove();
  }
});
