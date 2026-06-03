import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentSkillTarget = "codex" | "claude" | "opencode";

export type ManagedSkillInstallStatus = "installed" | "updated" | "unchanged" | "skipped" | "missing-source" | "error";

export type ManagedSkillInstallResult = {
  target: AgentSkillTarget;
  skillName: string;
  sourcePath: string;
  destinationPath: string;
  status: ManagedSkillInstallStatus;
  message?: string;
};

export type ManagedSkillManifest = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ManagedSkillManifestEntry>;
};

export type ManagedSkillManifestEntry = {
  target: AgentSkillTarget;
  skillName: string;
  destinationPath: string;
  sourceHash: string;
  installedHash: string;
  installedAt: string;
  updatedAt: string;
};

export type InstallManagedAgentSkillsOptions = {
  homeDir?: string;
  sourceRoot?: string | null;
  manifestPath?: string;
  now?: Date;
};

const MANIFEST_VERSION = 1;
const ATHENA_SKILL_NAME = "athena-context-workspace";

export function installManagedAgentSkills(options: InstallManagedAgentSkillsOptions = {}): ManagedSkillInstallResult[] {
  const homeDir = options.homeDir ?? os.homedir();
  const sourceRoot = options.sourceRoot ?? resolveBundledSkillsRoot();
  const manifestPath = options.manifestPath ?? defaultManifestPath(homeDir);
  const now = options.now ?? new Date();
  const manifest = readManifest(manifestPath);

  const results = managedSkillTargets(homeDir).map((target) => {
    const sourcePath = path.join(sourceRoot ?? "", ATHENA_SKILL_NAME);
    return installManagedSkill({
      target: target.target,
      skillName: ATHENA_SKILL_NAME,
      sourcePath,
      destinationPath: target.destinationPath,
      manifest,
      now,
    });
  });

  if (results.some((result) => result.status === "installed" || result.status === "updated")) {
    writeManifest(manifestPath, manifest, now);
  }

  return results;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveBundledSkillsRoot(appRoot = path.resolve(__dirname, "..")): string | null {
  const candidates = appRoot.includes(".asar")
    ? [path.join(path.dirname(appRoot), "agent-skills")]
    : [
        path.resolve(appRoot, "..", "agent-skills"),
        path.resolve(process.cwd(), "..", "agent-skills"),
        path.resolve(process.cwd(), "agent-skills"),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) ?? null;
}

export function managedSkillTargets(homeDir: string): { target: AgentSkillTarget; destinationPath: string }[] {
  return [
    { target: "codex", destinationPath: path.join(homeDir, ".codex", "skills", ATHENA_SKILL_NAME) },
    { target: "claude", destinationPath: path.join(homeDir, ".claude", "skills", ATHENA_SKILL_NAME) },
    { target: "opencode", destinationPath: path.join(homeDir, ".config", "opencode", "skills", ATHENA_SKILL_NAME) },
  ];
}

function installManagedSkill(input: {
  target: AgentSkillTarget;
  skillName: string;
  sourcePath: string;
  destinationPath: string;
  manifest: ManagedSkillManifest;
  now: Date;
}): ManagedSkillInstallResult {
  try {
    if (!fs.existsSync(input.sourcePath) || !fs.statSync(input.sourcePath).isDirectory()) {
      return result(input, "missing-source", "Bundled skill source was not found.");
    }

    const sourceHash = hashDirectory(input.sourcePath);
    const entryKey = manifestEntryKey(input.target, input.skillName, input.destinationPath);
    const previous = input.manifest.entries[entryKey];

    if (!fs.existsSync(input.destinationPath)) {
      copyDirectory(input.sourcePath, input.destinationPath);
      recordManifestEntry(input, sourceHash, sourceHash, entryKey, previous);
      return result(input, "installed");
    }

    const currentHash = hashDirectory(input.destinationPath);
    if (currentHash === sourceHash) {
      return result(input, "unchanged");
    }

    if (previous && currentHash === previous.installedHash) {
      replaceDirectory(input.sourcePath, input.destinationPath);
      recordManifestEntry(input, sourceHash, sourceHash, entryKey, previous);
      return result(input, "updated");
    }

    return result(input, "skipped", "Destination exists and was not created by Athena, or it has user edits.");
  } catch (error) {
    return result(input, "error", error instanceof Error ? error.message : String(error));
  }
}

function recordManifestEntry(
  input: {
    target: AgentSkillTarget;
    skillName: string;
    destinationPath: string;
    manifest: ManagedSkillManifest;
    now: Date;
  },
  sourceHash: string,
  installedHash: string,
  entryKey: string,
  previous?: ManagedSkillManifestEntry,
): void {
  const timestamp = input.now.toISOString();
  input.manifest.entries[entryKey] = {
    target: input.target,
    skillName: input.skillName,
    destinationPath: input.destinationPath,
    sourceHash,
    installedHash,
    installedAt: previous?.installedAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function result(
  input: { target: AgentSkillTarget; skillName: string; sourcePath: string; destinationPath: string },
  status: ManagedSkillInstallStatus,
  message?: string,
): ManagedSkillInstallResult {
  return {
    target: input.target,
    skillName: input.skillName,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
    status,
    message,
  };
}

function readManifest(manifestPath: string): ManagedSkillManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ManagedSkillManifest;
    if (parsed.version === MANIFEST_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch {
    // Missing or invalid manifests are replaced on the next successful install.
  }
  return { version: MANIFEST_VERSION, updatedAt: new Date(0).toISOString(), entries: {} };
}

function writeManifest(manifestPath: string, manifest: ManagedSkillManifest, now: Date): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const next: ManagedSkillManifest = {
    version: MANIFEST_VERSION,
    updatedAt: now.toISOString(),
    entries: manifest.entries,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function defaultManifestPath(homeDir: string): string {
  return path.join(homeDir, ".context-workspace", "agent-skills.json");
}

function manifestEntryKey(target: AgentSkillTarget, skillName: string, destinationPath: string): string {
  return `${target}:${skillName}:${path.resolve(destinationPath)}`;
}

function replaceDirectory(sourcePath: string, destinationPath: string): void {
  fs.rmSync(destinationPath, { recursive: true, force: true });
  copyDirectory(sourcePath, destinationPath);
}

function copyDirectory(sourcePath: string, destinationPath: string): void {
  fs.mkdirSync(destinationPath, { recursive: true });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourceEntry, destinationEntry);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourceEntry, destinationEntry);
      fs.chmodSync(destinationEntry, fs.statSync(sourceEntry).mode);
    }
  }
}

function hashDirectory(directory: string): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listFiles(directory)) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}
