const NVM_INCOMPATIBLE_NPM_ENV = [
  "npm_config_prefix",
  "NPM_CONFIG_PREFIX",
  "npm_config_globalconfig",
  "NPM_CONFIG_GLOBALCONFIG",
];

export function sanitizedTerminalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of NVM_INCOMPATIBLE_NPM_ENV) {
    delete env[key];
  }
  return env;
}
