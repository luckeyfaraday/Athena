import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NVM_INCOMPATIBLE_NPM_ENV = [
  "npm_config_prefix",
  "npm_config_globalconfig",
  "NPM_CONFIG_GLOBALCONFIG",
];

export function sanitizedTerminalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of NVM_INCOMPATIBLE_NPM_ENV) {
    delete env[key];
  }
  env.NPM_CONFIG_PREFIX = npmGlobalPrefix(source);
  return env;
}

function npmGlobalPrefix(source: NodeJS.ProcessEnv): string {
  const existing = source.NPM_CONFIG_PREFIX?.trim();
  if (existing) return existing;
  const userGlobal = path.join(os.homedir(), ".npm-global");
  if (fs.existsSync(userGlobal)) return userGlobal;
  return path.join(os.homedir(), ".npm-global");
}
