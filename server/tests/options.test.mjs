import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseServerOptions, acquireServerLock, serverServiceFile } from "../dist/server-options.js";

test("service configuration rejects invalid flags and produces a user service with explicit paths", () => {
  for (const args of [["--port", "0"], ["--port", "NaN"], ["--data-dir"], ["--unknown"], ["oops"]]) {
    assert.throws(() => parseServerOptions(args));
  }
  const options = parseServerOptions(["service-file", "--data-dir", "/home/test/state 100%", "--port", "47822", "--restore", "--workspace", "/home/test/a b"]);
  const unit = serverServiceFile(options, "/home/test/app/dist/server-main.js", "/home/test/app/.venv/bin/python");
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /100%%/);
  assert.match(unit, /"--restore"/);
  assert.match(unit, /"--port" "47822"/);
  assert.doesNotMatch(unit, /athena_remote_/);
  assert.throws(() => serverServiceFile(options, "bad\nExecStart=bad", "python"));
});

test("instance lock leaves a live owner intact and releases only its own file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-lock-test-"));
  try {
    const release = acquireServerLock(root);
    assert.throws(() => acquireServerLock(root), /already running/);
    release();
    const again = acquireServerLock(root);
    fs.writeFileSync(path.join(root, "server.lock"), "replacement");
    again();
    assert.equal(fs.readFileSync(path.join(root, "server.lock"), "utf8"), "replacement");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
