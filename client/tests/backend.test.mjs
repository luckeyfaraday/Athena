import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  defaultHermesRefreshCommand,
  formatBackendExitError,
  resolveBackendLaunch,
} from "../dist-electron/backend.js";

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

test("packaged recall refreshes run through the bundled runtime", () => {
  withoutPythonOverride(() => {
    const appRoot = path.join(path.parse(process.cwd()).root, "opt", "ATHENA", "resources", "app.asar");
    const launch = resolveBackendLaunch(appRoot, 43210);

    assert.equal(
      defaultHermesRefreshCommand(appRoot, launch),
      `"${launch.command}" --refresh-recall-script "${path.join(path.dirname(appRoot), "scripts", "hermes-refresh-recall.py")}"`,
    );
  });
});

test("backend exit errors preserve actionable stderr", () => {
  assert.equal(
    formatBackendExitError("Backend exited: 1", "/usr/bin/python3: No module named uvicorn\n"),
    "Backend exited: 1\n/usr/bin/python3: No module named uvicorn",
  );
  assert.equal(formatBackendExitError("Backend exited: 1", "  \n"), "Backend exited: 1");
});
