import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installAthenaCli } from "../dist-electron/athena-cli.js";

test("AppImage installs a working CLI outside its ephemeral mount", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-cli-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, ".mount_ATHENA123", "resources");
  const runtimeRoot = path.join(root, "stable-runtime");
  const targetPath = path.join(home, ".local", "bin", "athena");
  writeRuntime(sourceRoot, "initial");

  const result = installAthenaCli({ homeDir: home, sourceRoot, runtimeRoot, targetPath, python: "/usr/bin/python3" });

  assert.equal(result.status, "installed");
  assert.equal(result.sourceRoot, runtimeRoot);
  assert.equal(fs.readFileSync(path.join(runtimeRoot, "cli", "version.txt"), "utf8"), "initial");
  const shim = fs.readFileSync(targetPath, "utf8");
  assert.match(shim, new RegExp(escapeRegExp(runtimeRoot)));
  assert.doesNotMatch(shim, /\.mount_ATHENA123/);

  fs.rmSync(path.dirname(sourceRoot), { recursive: true });
  const invocation = childProcess.spawnSync(targetPath, [], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: "" },
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  assert.equal(invocation.stdout.trim(), "initial");
});

test("AppImage refreshes the stable CLI runtime when Athena starts", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-cli-update-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, ".mount_ATHENA456", "resources");
  const runtimeRoot = path.join(root, "stable-runtime");
  const targetPath = path.join(home, ".local", "bin", "athena");
  writeRuntime(sourceRoot, "initial");
  installAthenaCli({ homeDir: home, sourceRoot, runtimeRoot, targetPath, python: "/usr/bin/python3" });
  writeRuntime(sourceRoot, "updated");

  const result = installAthenaCli({ homeDir: home, sourceRoot, runtimeRoot, targetPath, python: "/usr/bin/python3" });

  assert.equal(result.status, "unchanged");
  assert.equal(fs.readFileSync(path.join(runtimeRoot, "cli", "version.txt"), "utf8"), "updated");
});

test("packaged Athena version works for a clean user without backend dependencies", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-cli-real-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, ".mount_ATHENA789", "resources");
  const runtimeRoot = path.join(root, "stable-runtime");
  const targetPath = path.join(home, ".local", "bin", "athena");
  const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
  for (const directory of ["backend", "cli", "mcp_server", "scripts"]) {
    fs.cpSync(path.join(repositoryRoot, directory), path.join(sourceRoot, directory), { recursive: true });
  }

  installAthenaCli({ homeDir: home, sourceRoot, runtimeRoot, targetPath, python: "/usr/bin/python3" });
  fs.rmSync(path.dirname(sourceRoot), { recursive: true });
  const invocation = childProcess.spawnSync(targetPath, ["--version"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, PYTHONPATH: "" },
  });

  assert.equal(invocation.status, 0, invocation.stderr);
  assert.match(invocation.stdout, /^athena /);
});

function writeRuntime(root, version) {
  for (const directory of ["backend", "cli", "mcp_server", "scripts"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "version.txt"), version, "utf8");
  }
  fs.writeFileSync(
    path.join(root, "cli", "__main__.py"),
    "from pathlib import Path\nprint((Path(__file__).parent / 'version.txt').read_text())\n",
    "utf8",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
