import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `npm run dev` passes npm's own config to its children (npm_config_prefix and friends). Inside a terminal those
// break nvm and point `npm install -g` somewhere other than where the user's own terminals install, so they are
// removed. On Windows environment names are case-insensitive, so the upper-case spellings go too.
const NVM_INCOMPATIBLE_NPM_ENV = [
  "npm_config_prefix",
  "NPM_CONFIG_PREFIX",
  "npm_config_globalconfig",
  "NPM_CONFIG_GLOBALCONFIG",
];

// npm's machine-wide global prefix, as `npm prefix -g` reports it outside Athena: where `npm install -g` puts agent
// CLIs, and so where the user's own terminals find them. Athena never keeps a private prefix of its own: agents
// installed or updated inside Athena and outside it must be the same copies. undefined until resolved at startup.
let npmGlobalPrefix: string | null | undefined;

export async function resolveNpmGlobalPrefix(source: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const env = { ...source };
  for (const key of NVM_INCOMPATIBLE_NPM_ENV) delete env[key];
  try {
    const { stdout } = process.platform === "win32"
      ? await execFileAsync("cmd.exe", ["/d", "/s", "/c", "npm prefix -g"], { env, windowsHide: true, timeout: 15000 })
      : await execFileAsync("npm", ["prefix", "-g"], { env, timeout: 15000 });
    const prefix = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
    npmGlobalPrefix = prefix && path.isAbsolute(prefix) ? prefix : defaultNpmGlobalPrefix(source);
  } catch {
    npmGlobalPrefix = defaultNpmGlobalPrefix(source);
  }
  return npmGlobalPrefix;
}

// Before `npm prefix -g` answers (or without npm), npm's documented default: %APPDATA%\npm on Windows. Elsewhere the
// prefix sits next to the node binary, which is on PATH already.
export function defaultNpmGlobalPrefix(source: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== "win32") return null;
  const appData = source.APPDATA?.trim();
  return appData ? path.join(appData, "npm") : null;
}

export function currentNpmGlobalPrefix(source: NodeJS.ProcessEnv = process.env): string | null {
  return npmGlobalPrefix === undefined ? defaultNpmGlobalPrefix(source) : npmGlobalPrefix;
}

export function npmGlobalBinPath(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? prefix : path.join(prefix, "bin");
}

export function sanitizedTerminalEnv(
  source: NodeJS.ProcessEnv = process.env,
  npmPrefix: string | null = currentNpmGlobalPrefix(source),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  removeInheritedVirtualEnvironment(env);
  for (const key of NVM_INCOMPATIBLE_NPM_ENV) {
    delete env[key];
  }
  // The machine-wide npm bin goes last, and only when it exists and is missing: the user's own PATH order decides
  // which copy of a CLI runs, exactly as in their other terminals.
  if (npmPrefix) {
    const bin = npmGlobalBinPath(npmPrefix);
    if (fs.existsSync(bin)) appendPathEntry(env, bin);
  }
  prependSelectedPython(env, source.CONTEXT_WORKSPACE_PYTHON);
  return env;
}

function removeInheritedVirtualEnvironment(env: NodeJS.ProcessEnv): void {
  const virtualEnv = env.VIRTUAL_ENV?.trim();
  delete env.VIRTUAL_ENV;
  delete env.PYTHONHOME;
  if (!virtualEnv) return;

  const pathKey = pathKeyOf(env);
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

export function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return "Path" in env && !("PATH" in env) ? "Path" : "PATH";
}

function prependPathEntry(env: NodeJS.ProcessEnv, entry: string): void {
  addPathEntry(env, entry, "front");
}

function appendPathEntry(env: NodeJS.ProcessEnv, entry: string): void {
  addPathEntry(env, entry, "back");
}

function addPathEntry(env: NodeJS.ProcessEnv, entry: string, where: "front" | "back"): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const pathKey = pathKeyOf(env);
  const current = env[pathKey] ?? "";
  const entries = current.split(path.delimiter).filter(Boolean);
  const normalizedEntry = normalizePathEntry(trimmed);
  if (entries.some((item) => normalizePathEntry(item) === normalizedEntry)) {
    env[pathKey] = current;
    return;
  }
  env[pathKey] = (where === "front" ? [trimmed, ...entries] : [...entries, trimmed]).join(path.delimiter);
}

// PATH entries from `extra` that `current` lacks, appended in order (for picking up an installer's new PATH entry).
export function mergePathEntries(current: string, extra: string, delimiter = path.delimiter): string {
  const entries = current.split(delimiter).filter(Boolean);
  const seen = new Set(entries.map(normalizePathEntry));
  for (const entry of extra.split(delimiter).map((item) => item.trim()).filter(Boolean)) {
    const key = normalizePathEntry(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join(delimiter);
}

function normalizePathEntry(value: string): string {
  const normalized = path.normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
