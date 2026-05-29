import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateControlAccess,
  validatedWorkspacePath,
} from "../dist-electron/control-access.js";

const TOKEN = "a".repeat(64);

test("evaluateControlAccess rejects requests without a token", () => {
  const decision = evaluateControlAccess({ host: "127.0.0.1:5000" }, TOKEN);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
});

test("evaluateControlAccess accepts a correct bearer token", () => {
  const decision = evaluateControlAccess({ host: "127.0.0.1:5000", authorization: `Bearer ${TOKEN}` }, TOKEN);
  assert.equal(decision.ok, true);
});

test("evaluateControlAccess accepts the X-Athena-Control-Token header", () => {
  const decision = evaluateControlAccess({ host: "localhost:5000", token: TOKEN }, TOKEN);
  assert.equal(decision.ok, true);
});

test("evaluateControlAccess rejects an incorrect token", () => {
  const decision = evaluateControlAccess({ host: "127.0.0.1:5000", authorization: `Bearer ${"b".repeat(64)}` }, TOKEN);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
});

test("evaluateControlAccess blocks non-loopback Host headers (DNS rebinding)", () => {
  const decision = evaluateControlAccess({ host: "evil.example.com:5000", authorization: `Bearer ${TOKEN}` }, TOKEN);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
});

test("evaluateControlAccess blocks cross-origin browser callers (CSRF)", () => {
  const decision = evaluateControlAccess(
    { host: "127.0.0.1:5000", origin: "https://evil.example.com", authorization: `Bearer ${TOKEN}` },
    TOKEN,
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
});

test("evaluateControlAccess allows a loopback Origin with a valid token", () => {
  const decision = evaluateControlAccess(
    { host: "127.0.0.1:5000", origin: "http://127.0.0.1:5000", authorization: `Bearer ${TOKEN}` },
    TOKEN,
  );
  assert.equal(decision.ok, true);
});

test("evaluateControlAccess returns 503 before the token is initialized", () => {
  const decision = evaluateControlAccess({ host: "127.0.0.1:5000", authorization: `Bearer ${TOKEN}` }, null);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
});

test("validatedWorkspacePath resolves a real directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-ws-"));
  try {
    assert.equal(validatedWorkspacePath(dir), fs.realpathSync.native(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validatedWorkspacePath rejects URLs, relative paths, and missing input", () => {
  assert.throws(() => validatedWorkspacePath("http://example.com/x"), /local filesystem path/);
  assert.throws(() => validatedWorkspacePath("relative/dir"), /absolute path/);
  assert.throws(() => validatedWorkspacePath(""), /project_dir is required/);
});

test("validatedWorkspacePath refuses protected posix roots and the home directory", () => {
  if (process.platform === "win32") return;
  assert.throws(() => validatedWorkspacePath("/etc"), /protected directory/);
  assert.throws(() => validatedWorkspacePath(os.homedir()), /home directory/);
});
