// The coding-agent CLIs Athena launches, and where they come from.
//
// Athena never keeps copies of its own: every pane runs the machine-wide install, the same binary the user's other
// terminals find on PATH, so updating an agent inside Athena or outside it updates the one copy. This module finds
// each CLI exactly the way the panes do (same environment, same lookup), reports what is installed, and builds the
// visible-pane commands that install or update an agent. The Command Room asks it before launching an agent, so a
// missing one leads to an install prompt instead of a dead terminal.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EmbeddedTerminalKind } from "./embedded-terminal.js";
import { isWindows, nvmLoadBashCommand, preferredWindowsPowerShell, quotePowerShell, quoteShell } from "./platform.js";
import { currentNpmGlobalPrefix, mergePathEntries, pathKeyOf, sanitizedTerminalEnv } from "./terminal-env.js";

const execFileAsync = promisify(execFile);

export type AgentCliKind = Exclude<EmbeddedTerminalKind, "shell">;
export type AgentSetupAction = "install" | "update" | "cleanup";
type PerPlatform = { win32: string; posix: string };

export type AgentCliSpec = {
  kind: AgentCliKind;
  label: string;
  executable: string;
  // npm package for CLIs installed with npm; they install into npm's machine-wide prefix like any `npm install -g`
  npmPackage: string | null;
  install: PerPlatform;
  update: PerPlatform;
  // the CLI's own updater, used when the copy on PATH did not come from npm (a native installer, Homebrew...), so an
  // update never adds a second copy next to the one that runs
  selfUpdate?: string;
  docsUrl: string;
};

const npmLatest = (pkg: string): PerPlatform => ({ win32: `npm install -g ${pkg}@latest`, posix: `npm install -g ${pkg}@latest` });
const installer = (win32: string, posix: string): PerPlatform => ({ win32, posix });

// The vendors' own installers re-run cleanly over an existing install, so "update" is the installer again.
const HERMES = installer(
  "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
  "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
);
const GROK = installer("irm https://x.ai/cli/install.ps1 | iex", "curl -fsSL https://x.ai/cli/install.sh | bash");
const ATHENA_CODE = installer(
  "irm https://raw.githubusercontent.com/luckeyfaraday/athena-code/main/scripts/install.ps1 | iex",
  "curl -fsSL https://raw.githubusercontent.com/luckeyfaraday/athena-code/main/scripts/install.sh | bash",
);

export const AGENT_CLIS: Record<AgentCliKind, AgentCliSpec> = {
  claude: {
    kind: "claude", label: "Claude Code", executable: "claude", npmPackage: "@anthropic-ai/claude-code",
    install: npmLatest("@anthropic-ai/claude-code"), update: npmLatest("@anthropic-ai/claude-code"), selfUpdate: "claude update",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  codex: {
    kind: "codex", label: "Codex", executable: "codex", npmPackage: "@openai/codex",
    install: npmLatest("@openai/codex"), update: npmLatest("@openai/codex"),
    docsUrl: "https://github.com/openai/codex",
  },
  opencode: {
    kind: "opencode", label: "OpenCode", executable: "opencode", npmPackage: "opencode-ai",
    install: npmLatest("opencode-ai"), update: npmLatest("opencode-ai"), selfUpdate: "opencode upgrade",
    docsUrl: "https://opencode.ai/docs",
  },
  hermes: {
    kind: "hermes", label: "Hermes", executable: "hermes", npmPackage: null,
    install: HERMES, update: HERMES,
    docsUrl: "https://github.com/NousResearch/hermes-agent",
  },
  grok: {
    kind: "grok", label: "Grok", executable: "grok", npmPackage: null,
    install: GROK, update: GROK,
    docsUrl: "https://docs.x.ai/build/overview",
  },
  athena: {
    kind: "athena", label: "Athena Code", executable: "athena-code", npmPackage: null,
    install: ATHENA_CODE, update: ATHENA_CODE,
    docsUrl: "https://github.com/luckeyfaraday/athena-code",
  },
};

export function isAgentCliKind(value: unknown): value is AgentCliKind {
  return typeof value === "string" && Object.hasOwn(AGENT_CLIS, value);
}

export function agentCommand(kind: AgentCliKind, action: "install" | "update", platform: NodeJS.Platform = process.platform): string {
  const spec = AGENT_CLIS[kind][action];
  return platform === "win32" ? spec.win32 : spec.posix;
}

export type AgentCliStatus = {
  kind: AgentCliKind;
  label: string;
  executable: string;
  installed: boolean;
  path: string | null;
  installCommand: string;
  updateCommand: string;
  docsUrl: string;
  // true when install/update runs npm, and whether npm itself is on PATH
  needsNpm: boolean;
  npmAvailable: boolean;
};

// Finds a command the way an agent pane does: the pane's environment, `where.exe` on Windows (panes resolve with
// PowerShell's Get-Command over the same PATH), and on Linux/macOS a login bash with nvm loaded, like `bash -lc`.
export async function resolveExecutable(executable: string, env: NodeJS.ProcessEnv = sanitizedTerminalEnv()): Promise<string | null> {
  try {
    const { stdout } = isWindows
      // Get-Command also runs .ps1 scripts, which PATHEXT leaves out: look for those too
      ? await execFileAsync("where.exe", [executable], { env: withPs1Extension(env), windowsHide: true, timeout: 10000 })
      : await execFileAsync("bash", ["-lc", `${nvmLoadBashCommand()}; command -v ${quoteShell(executable)}`], { env, timeout: 10000 });
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    if (!isWindows) return lines[0];
    // where.exe also lists npm's extensionless sh script next to its .cmd shim: report the one Windows runs, from the
    // same folder as the first match
    const first = lines[0], folder = path.dirname(first).toLowerCase();
    return lines.find((line) => path.dirname(line).toLowerCase() === folder && /\.(exe|cmd|bat|com|ps1)$/i.test(line)) ?? first;
  } catch {
    return null;
  }
}

function withPs1Extension(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATHEXT") ?? "PATHEXT";
  const current = env[key] ?? ".COM;.EXE;.BAT;.CMD";
  return current.toUpperCase().split(";").includes(".PS1") ? env : { ...env, [key]: `${current};.PS1` };
}

// The command that updates the copy that actually runs: npm for a copy in npm's global prefix (or when none is
// installed yet), the CLI's own updater for a copy that came from elsewhere.
export function agentUpdateCommand(
  kind: AgentCliKind,
  resolved: string | null,
  npmPrefix: string | null = currentNpmGlobalPrefix(),
  platform: NodeJS.Platform = process.platform,
): string {
  const spec = AGENT_CLIS[kind];
  if (!spec.npmPackage || !spec.selfUpdate || !resolved || !npmPrefix) return agentCommand(kind, "update", platform);
  const p = pathFor(platform);
  const dir = normalizedPath(p.dirname(resolved), platform), prefix = normalizedPath(npmPrefix, platform);
  const fromNpm = dir === prefix || dir.startsWith(prefix + p.sep);
  return fromNpm ? agentCommand(kind, "update", platform) : spec.selfUpdate;
}

export async function agentCliStatus(kind: AgentCliKind, env: NodeJS.ProcessEnv = sanitizedTerminalEnv()): Promise<AgentCliStatus> {
  const spec = AGENT_CLIS[kind];
  const [found, npm] = await Promise.all([
    resolveExecutable(spec.executable, env),
    spec.npmPackage ? resolveExecutable("npm", env) : Promise.resolve(null),
  ]);
  return {
    kind,
    label: spec.label,
    executable: spec.executable,
    installed: found !== null,
    path: found,
    installCommand: agentCommand(kind, "install"),
    updateCommand: agentUpdateCommand(kind, found),
    docsUrl: spec.docsUrl,
    needsNpm: spec.npmPackage !== null,
    npmAvailable: spec.npmPackage ? npm !== null : true,
  };
}

export async function agentCliStatuses(): Promise<AgentCliStatus[]> {
  const env = sanitizedTerminalEnv();
  return Promise.all((Object.keys(AGENT_CLIS) as AgentCliKind[]).map((kind) => agentCliStatus(kind, env)));
}

export type PrivateAgentCopies = {
  prefix: string;
  kinds: AgentCliKind[];
  packages: string[];
  labels: string[];
  command: string;
};

// Earlier Athena versions installed and updated npm agents into a private prefix, ~/.npm-global, and ran those copies
// instead of the machine-wide ones. Report agent packages still sitting there, so the user can remove them. A prefix
// that is npm's real one (the user chose ~/.npm-global themselves) is left alone.
export function privateAgentCopies(
  home = os.homedir(),
  realPrefix: string | null = currentNpmGlobalPrefix(),
  platform: NodeJS.Platform = process.platform,
): PrivateAgentCopies | null {
  const prefix = path.join(home, ".npm-global");
  if (!fs.existsSync(prefix)) return null;
  if (realPrefix && samePath(realPrefix, prefix, platform)) return null;
  const modules = platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const found = Object.values(AGENT_CLIS).filter((spec) => spec.npmPackage && fs.existsSync(path.join(modules, ...spec.npmPackage.split("/"))));
  if (!found.length) return null;
  const packages = found.map((spec) => spec.npmPackage as string);
  return {
    prefix,
    kinds: found.map((spec) => spec.kind),
    packages,
    labels: found.map((spec) => spec.label),
    command: `npm uninstall -g --prefix "${prefix}" ${packages.join(" ")}`,
  };
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return normalizedPath(a, platform) === normalizedPath(b, platform);
}

// Paths are compared by the rules of the platform they belong to, not the host's (tests check Windows paths on Linux).
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const normalized = pathFor(platform).normalize(value.trim()).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function agentSetupTitle(kind: AgentCliKind, action: AgentSetupAction): string {
  const label = AGENT_CLIS[kind].label;
  return action === "install" ? `Installing ${label}` : action === "update" ? `Updating ${label}` : "Removing old agent copies";
}

export function agentSetupCommand(kind: AgentCliKind, action: AgentSetupAction, platform: NodeJS.Platform = process.platform): string | null {
  if (action === "cleanup") return privateAgentCopies(os.homedir(), currentNpmGlobalPrefix(), platform)?.command ?? null;
  return agentCommand(kind, action, platform);
}

// A visible pane that runs one install, update or cleanup command, prints what it runs, and exits with the command's
// status, so the Command Room can tell when it finished and whether it worked.
export function agentSetupLaunch(
  kind: AgentCliKind,
  action: AgentSetupAction,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  powerShell: "pwsh.exe" | "powershell.exe" = preferredWindowsPowerShell(),
  script: string | null = agentSetupCommand(kind, action, platform),
): { command: string; args: string[]; title: string; script: string } {
  const title = agentSetupTitle(kind, action);
  if (!script) throw new Error("There are no old agent copies to remove.");
  return setupScriptLaunch(title, script, cwd, platform, powerShell);
}

// The setup pane for this machine: an update updates the copy that actually runs (see agentUpdateCommand).
export async function resolveAgentSetupLaunch(
  kind: AgentCliKind,
  action: AgentSetupAction,
  cwd: string,
): Promise<{ command: string; args: string[]; title: string; script: string }> {
  const script = action === "update" ? (await agentCliStatus(kind)).updateCommand : agentSetupCommand(kind, action);
  return agentSetupLaunch(kind, action, cwd, process.platform, preferredWindowsPowerShell(), script);
}

export function setupScriptLaunch(
  title: string,
  script: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  powerShell: "pwsh.exe" | "powershell.exe" = preferredWindowsPowerShell(),
): { command: string; args: string[]; title: string; script: string } {
  if (platform === "win32") {
    return {
      command: powerShell,
      title,
      script,
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", [
        `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
        `Write-Host ${quotePowerShell(`[Athena] ${title}: ${script}`)} -ForegroundColor Cyan`,
        `try { ${script}; if ($LASTEXITCODE) { Write-Host "[Athena] Failed with exit code $LASTEXITCODE." -ForegroundColor Red; exit $LASTEXITCODE } } catch { Write-Host $_ -ForegroundColor Red; exit 1 }`,
        `Write-Host '[Athena] Done.' -ForegroundColor Green`,
        "exit 0",
      ].join("; ")],
    };
  }
  return {
    command: "bash",
    title,
    script,
    args: ["-lc", [
      nvmLoadBashCommand(),
      `cd ${quoteShell(cwd)}`,
      `printf '\\033[36m%s\\033[0m\\n' ${quoteShell(`[Athena] ${title}: ${script}`)}`,
      script,
      "status=$?",
      "if [ $status -eq 0 ]; then printf '\\033[32m[Athena] Done.\\033[0m\\n'; else printf '\\033[31m[Athena] Failed with exit code %s.\\033[0m\\n' \"$status\"; fi",
      "exit $status",
    ].join("; ")],
  };
}

// Installers (Grok, Athena Code, Hermes) add their folder to the user's PATH in the registry, but a running app keeps
// the PATH it started with. Pick up new entries so a freshly installed agent launches without restarting Athena.
export async function refreshPathFromSystem(): Promise<boolean> {
  if (!isWindows) return false;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { windowsHide: true, timeout: 15000 },
    );
    const key = pathKeyOf(process.env);
    const before = process.env[key] ?? "";
    const after = mergePathEntries(before, stdout.trim(), ";");
    if (after === before) return false;
    process.env[key] = after;
    return true;
  } catch {
    return false;
  }
}

// The line a pane prints when its agent is missing (the Command Room normally asks to install it before launching).
export function missingAgentMessage(kind: EmbeddedTerminalKind, executable: string, platform: NodeJS.Platform = process.platform): string {
  if (!isAgentCliKind(kind)) return `${executable} is not installed or not on PATH.`;
  const spec = AGENT_CLIS[kind];
  return `${spec.label} (${executable}) is not installed or not on PATH. Install it with: ${agentCommand(kind, "install", platform)}  (or choose it from New in Athena, which offers to install it). Docs: ${spec.docsUrl}`;
}
