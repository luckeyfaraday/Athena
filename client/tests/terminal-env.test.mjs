import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sanitizedTerminalEnv } from "../dist-electron/terminal-env.js";

test("terminal env strips lowercase npm prefix values that make nvm warn", () => {
  const env = sanitizedTerminalEnv({
    PATH: "/bin",
    npm_config_prefix: "/home/user/.npm-global",
    NPM_CONFIG_PREFIX: "/home/user/.npm-global",
    npm_config_globalconfig: "/home/user/.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/home/user/.npmrc",
  });

  assert.equal(env.PATH, ["/home/user/.npm-global/bin", "/bin"].join(path.delimiter));
  assert.equal("npm_config_prefix" in env, false);
  assert.equal(env.NPM_CONFIG_PREFIX, "/home/user/.npm-global");
  assert.equal("npm_config_globalconfig" in env, false);
  assert.equal("NPM_CONFIG_GLOBALCONFIG" in env, false);
});

test("terminal env sets a user npm global prefix when none is configured", () => {
  const env = sanitizedTerminalEnv({
    PATH: "/bin",
  });

  assert.equal(env.NPM_CONFIG_PREFIX ?? "", path.join(os.homedir(), ".npm-global"));
  assert.equal(env.PATH?.split(path.delimiter).at(0), path.join(os.homedir(), ".npm-global", "bin"));
});

test("terminal env does not duplicate npm global bin path in PATH", () => {
  const prefix = path.join(os.homedir(), ".npm-global");
  const binPath = path.join(prefix, "bin");
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
  assert.equal(env.Path, [path.join(prefix, "bin"), "C:\\Windows\\System32"].join(path.delimiter));
  assert.equal("PATH" in env, false);
});
