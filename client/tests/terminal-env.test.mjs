import assert from "node:assert/strict";
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

  assert.equal(env.PATH, "/bin");
  assert.equal("npm_config_prefix" in env, false);
  assert.equal(env.NPM_CONFIG_PREFIX, "/home/user/.npm-global");
  assert.equal("npm_config_globalconfig" in env, false);
  assert.equal("NPM_CONFIG_GLOBALCONFIG" in env, false);
});

test("terminal env sets a user npm global prefix when none is configured", () => {
  const env = sanitizedTerminalEnv({
    PATH: "/bin",
  });

  assert.match(env.NPM_CONFIG_PREFIX ?? "", /\/\.npm-global$/);
});
