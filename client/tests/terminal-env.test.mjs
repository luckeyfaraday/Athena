import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sanitizedTerminalEnv } from "../dist-electron/terminal-env.js";

function npmGlobalBinPath(prefix) {
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

test("terminal env strips lowercase npm values that make nvm warn", () => {
  const prefix = "/home/user/.npm-global";
  const env = sanitizedTerminalEnv({
    PATH: "/bin",
    npm_config_prefix: prefix,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_globalconfig: "/home/user/.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/home/user/.npmrc",
  });

  assert.equal(env.PATH, [npmGlobalBinPath(prefix), "/bin"].join(path.delimiter));
  assert.equal("npm_config_prefix" in env, false);
  assert.equal(env.NPM_CONFIG_PREFIX, prefix);
  assert.equal("npm_config_globalconfig" in env, false);
  assert.equal("NPM_CONFIG_GLOBALCONFIG" in env, false);
});

test("terminal env sets user npm global prefix and prepends bin path", () => {
  const env = sanitizedTerminalEnv({
    PATH: "/bin",
  });

  const prefix = path.join(os.homedir(), ".npm-global");
  assert.equal(env.NPM_CONFIG_PREFIX, prefix);
  assert.equal(env.PATH?.split(path.delimiter).at(0), npmGlobalBinPath(prefix));
});

test("terminal env does not duplicate npm global bin path in PATH", () => {
  const prefix = path.join(os.homedir(), ".npm-global");
  const binPath = npmGlobalBinPath(prefix);
  const env = sanitizedTerminalEnv({
    PATH: [binPath, "/bin"].join(path.delimiter),
  });

  assert.equal(env.PATH, [binPath, "/bin"].join(path.delimiter));
});

test("terminal env preserves Windows-style Path key", () => {
  const prefix = "C:\\Users\\you\\.npm-global";
  const env = sanitizedTerminalEnv({
    Path: "C:\\Windows\\System32",
    NPM_CONFIG_PREFIX: prefix,
  });

  assert.equal(env.NPM_CONFIG_PREFIX, prefix);
  assert.equal(env.Path, [npmGlobalBinPath(prefix), "C:\\Windows\\System32"].join(path.delimiter));
  assert.equal("PATH" in env, false);
});
