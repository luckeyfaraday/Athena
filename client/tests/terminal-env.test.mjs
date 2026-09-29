import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergePathEntries, npmGlobalBinPath, sanitizedTerminalEnv } from "../dist-electron/terminal-env.js";

function tempPrefix() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "athena-npm-prefix-"));
  fs.mkdirSync(npmGlobalBinPath(prefix), { recursive: true });
  return prefix;
}

test("terminal env strips npm config that make nvm warn and point installs elsewhere", () => {
  const env = sanitizedTerminalEnv({
    PATH: "/bin",
    npm_config_prefix: "/somewhere",
    NPM_CONFIG_PREFIX: "/somewhere",
    npm_config_globalconfig: "/home/user/.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/home/user/.npmrc",
  }, null);

  assert.equal(env.PATH, "/bin");
  assert.equal("npm_config_prefix" in env, false);
  assert.equal("NPM_CONFIG_PREFIX" in env, false);
  assert.equal("npm_config_globalconfig" in env, false);
  assert.equal("NPM_CONFIG_GLOBALCONFIG" in env, false);
});

test("terminal env never invents a private npm prefix", () => {
  const env = sanitizedTerminalEnv({ PATH: "/bin" }, null);

  assert.equal(env.PATH, "/bin");
  assert.equal("CONTEXT_WORKSPACE_NPM_PREFIX" in env, false);
  assert.equal(env.PATH.includes(".npm-global"), false);
});

test("terminal env appends npm's machine-wide bin, last, when PATH lacks it", () => {
  const prefix = tempPrefix();
  const env = sanitizedTerminalEnv({ PATH: "/bin" }, prefix);

  assert.equal(env.PATH, ["/bin", npmGlobalBinPath(prefix)].join(path.delimiter));
});

test("terminal env keeps the user's PATH order when npm's bin is already there", () => {
  const prefix = tempPrefix();
  const bin = npmGlobalBinPath(prefix);
  const env = sanitizedTerminalEnv({ PATH: [bin, "/bin"].join(path.delimiter) }, prefix);

  assert.equal(env.PATH, [bin, "/bin"].join(path.delimiter));
});

test("terminal env skips an npm prefix whose bin folder does not exist", () => {
  const env = sanitizedTerminalEnv({ PATH: "/bin" }, path.join(os.tmpdir(), "athena-no-such-prefix"));

  assert.equal(env.PATH, "/bin");
});

test("terminal env preserves Windows-style Path key", () => {
  const env = sanitizedTerminalEnv({
    Path: "C:\\Windows\\System32",
    NPM_CONFIG_PREFIX: "C:\\Users\\you\\.npm-global",
  }, null);

  assert.equal("NPM_CONFIG_PREFIX" in env, false);
  assert.equal(env.Path, "C:\\Windows\\System32");
  assert.equal("PATH" in env, false);
});

test("mergePathEntries adds only the entries PATH lacks, in order", () => {
  assert.equal(mergePathEntries("/a;/b", "/b;/c;;/a;/d", ";"), "/a;/b;/c;/d");
  assert.equal(mergePathEntries("", "/x", ";"), "/x");
});

test("terminal env removes an inherited Python virtual environment", () => {
  const virtualEnv = path.join(os.homedir(), "tool-venv");
  const virtualEnvBin = process.platform === "win32"
    ? path.join(virtualEnv, "Scripts")
    : path.join(virtualEnv, "bin");
  const env = sanitizedTerminalEnv({
    PATH: [virtualEnvBin, "/usr/bin"].join(path.delimiter),
    VIRTUAL_ENV: virtualEnv,
    PYTHONHOME: virtualEnv,
  });

  assert.equal("VIRTUAL_ENV" in env, false);
  assert.equal("PYTHONHOME" in env, false);
  assert.equal(env.PATH?.split(path.delimiter).includes(virtualEnvBin), false);
});

test("terminal env puts the configured Athena Python first on PATH", () => {
  const python = path.resolve("selected-python", process.platform === "win32" ? "python.exe" : "python");
  const env = sanitizedTerminalEnv({
    PATH: "/usr/bin",
    CONTEXT_WORKSPACE_PYTHON: python,
  });

  assert.equal(env.PATH?.split(path.delimiter).at(0), path.dirname(python));
});
