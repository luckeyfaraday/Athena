import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";

import {
  formatBackendExitError,
  resolveBackendLaunch,
  stopBackend,
} from "../dist-electron/backend.js";

async function withTemporaryHome(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "athena-backend-home-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await callback(home);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function withoutPythonOverride(callback) {
  const previous = process.env.CONTEXT_WORKSPACE_PYTHON;
  delete process.env.CONTEXT_WORKSPACE_PYTHON;
  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_WORKSPACE_PYTHON;
    else process.env.CONTEXT_WORKSPACE_PYTHON = previous;
  }
}

test("packaged Athena launches its bundled backend runtime", () => {
  withoutPythonOverride(() => {
    const appRoot = path.join(path.parse(process.cwd()).root, "opt", "ATHENA", "resources", "app.asar");
    const launch = resolveBackendLaunch(appRoot, 43210);
    const executable = process.platform === "win32" ? "athena-backend.exe" : "athena-backend";

    assert.equal(launch.bundled, true);
    assert.equal(
      launch.command,
      path.join(path.dirname(appRoot), "backend-runtime", "athena-backend", executable),
    );
    assert.deepEqual(launch.args, ["--host", "127.0.0.1", "--port", "43210", "--no-access-log"]);
  });
});

test("an explicit Python override takes precedence over the packaged runtime", () => {
  const previous = process.env.CONTEXT_WORKSPACE_PYTHON;
  process.env.CONTEXT_WORKSPACE_PYTHON = "/custom/python";
  try {
    const launch = resolveBackendLaunch("/opt/ATHENA/resources/app.asar", 8765);
    assert.equal(launch.bundled, false);
    assert.equal(launch.command, "/custom/python");
    assert.deepEqual(launch.args.slice(0, 3), ["-m", "uvicorn", "backend.app:app"]);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_WORKSPACE_PYTHON;
    else process.env.CONTEXT_WORKSPACE_PYTHON = previous;
  }
});

test("backend launches no longer carry the retired recall refresh script", () => {
  withoutPythonOverride(() => {
    const appRoot = path.join(path.parse(process.cwd()).root, "opt", "ATHENA", "resources", "app.asar");
    const launch = resolveBackendLaunch(appRoot, 43210);
    assert.equal(launch.args.some((arg) => /refresh-recall/.test(arg)), false);
  });
});

test("backend discovery is rewritten only when its content changes or it goes missing", async () => {
  await withTemporaryHome(async (home) => {
    const discoveryPath = path.join(home, ".context-workspace", "backend.json");
    await stopBackend();
    const first = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
    assert.equal(first.running, false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopBackend();
    assert.equal(JSON.parse(fs.readFileSync(discoveryPath, "utf8")).updatedAt, first.updatedAt);

    // Another writer removed it (e.g. `athena serve` cleanup): self-heal.
    fs.rmSync(discoveryPath);
    await stopBackend();
    assert.equal(fs.existsSync(discoveryPath), true);
  });
});

test("backend exit errors preserve actionable stderr", () => {
  assert.equal(
    formatBackendExitError("Backend exited: 1", "/usr/bin/python3: No module named uvicorn\n"),
    "Backend exited: 1\n/usr/bin/python3: No module named uvicorn",
  );
  assert.equal(formatBackendExitError("Backend exited: 1", "  \n"), "Backend exited: 1");
});
