import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NVM_INCOMPATIBLE_NPM_ENV = [
  "npm_config_prefix",
  "NPM_CONFIG_PREFIX",
  "npm_config_globalconfig",
  "NPM_CONFIG_GLOBALCONFIG",
];

export function sanitizedTerminalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  removeInheritedVirtualEnvironment(env);
  for (const key of NVM_INCOMPATIBLE_NPM_ENV) {
    delete env[key];
  }
  const prefix = npmGlobalPrefix(source);
  env.CONTEXT_WORKSPACE_NPM_PREFIX = prefix;
  prependPathEntry(env, npmGlobalBinPath(prefix));
  prependSelectedPython(env, source.CONTEXT_WORKSPACE_PYTHON);
  return env;
}

function removeInheritedVirtualEnvironment(env: NodeJS.ProcessEnv): void {
  const virtualEnv = env.VIRTUAL_ENV?.trim();
  delete env.VIRTUAL_ENV;
  delete env.PYTHONHOME;
  if (!virtualEnv) return;

  const pathKey = "Path" in env && !("PATH" in env) ? "Path" : "PATH";
  const current = env[pathKey];
  if (!current) return;
  const virtualEnvBin = process.platform === "win32"
    ? path.join(virtualEnv, "Scripts")
    : path.join(virtualEnv, "bin");
  env[pathKey] = current
    .split(path.delimiter)
    .filter((entry) => normalizePathEntry(entry) !== normalizePathEntry(virtualEnvBin))
    .join(path.delimiter);
}

function prependSelectedPython(env: NodeJS.ProcessEnv, executable: string | undefined): void {
  const selected = executable?.trim();
  if (!selected || !path.isAbsolute(selected)) return;
  prependPathEntry(env, path.dirname(selected));
}

function npmGlobalPrefix(source: NodeJS.ProcessEnv): string {
  const existing = source.NPM_CONFIG_PREFIX?.trim();
  if (existing) return existing;
  const userGlobal = path.join(os.homedir(), ".npm-global");
  if (fs.existsSync(userGlobal)) return userGlobal;
  return path.join(os.homedir(), ".npm-global");
}

function npmGlobalBinPath(prefix: string): string {
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function prependPathEntry(env: NodeJS.ProcessEnv, entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const pathKey = "Path" in env && !("PATH" in env) ? "Path" : "PATH";
  const current = env[pathKey] ?? "";
  const entries = current.split(path.delimiter).filter(Boolean);
  const normalizedEntry = normalizePathEntry(trimmed);
  const hasEntry = entries.some((item) => normalizePathEntry(item) === normalizedEntry);
  if (hasEntry) {
    env[pathKey] = current;
    return;
  }
  env[pathKey] = [trimmed, ...entries].join(path.delimiter);
}

function normalizePathEntry(value: string): string {
  const normalized = path.normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
