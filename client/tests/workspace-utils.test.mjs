import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorkspaceKey, sameWorkspacePath } from "../src/workspace-utils.ts";

test("workspace keys preserve POSIX roots and case", () => {
  assert.equal(normalizeWorkspaceKey("/"), "/");
  assert.equal(normalizeWorkspaceKey("/Work/Project/"), "/Work/Project");
  assert.notEqual(normalizeWorkspaceKey("/Work/Project"), normalizeWorkspaceKey("/work/project"));
  assert.equal(sameWorkspacePath("/", "/"), true);
});

test("workspace keys unify Windows, WSL, drive roots, and UNC case", () => {
  assert.equal(normalizeWorkspaceKey("C:\\"), "c:/");
  assert.equal(normalizeWorkspaceKey("/mnt/C/"), "c:/");
  assert.equal(sameWorkspacePath("C:\\Users\\Alan", "/mnt/c/users/alan"), true);
  assert.equal(
    normalizeWorkspaceKey("\\\\Server\\Share\\Project"),
    normalizeWorkspaceKey("//server/share/project"),
  );
});
