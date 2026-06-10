import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installManagedAgentSkills, managedSkillTargets } from "../dist-electron/agent-skills.js";

const FIXED_NOW = new Date("2026-06-02T12:00:00.000Z");
const SKILL_NAME = "athena-context-workspace";

test("installManagedAgentSkills installs Athena skill for supported agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-skills-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "resources", "agent-skills");
  writeSkill(sourceRoot, "Initial instructions");

  const results = installManagedAgentSkills({ homeDir: home, sourceRoot, now: FIXED_NOW });

  assert.deepEqual(results.map((result) => result.status), ["installed", "installed", "installed"]);
  for (const target of managedSkillTargets(home)) {
    assert.equal(fs.readFileSync(path.join(target.destinationPath, "SKILL.md"), "utf8"), skillMarkdown("Initial instructions"));
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".context-workspace", "agent-skills.json"), "utf8"));
  assert.equal(Object.keys(manifest.entries).length, 3);
});

test("managedSkillTargets uses each agent's native skill directory", () => {
  const home = path.join(path.sep, "home", "dev");

  assert.deepEqual(managedSkillTargets(home), [
    { target: "codex", destinationPath: path.join(home, ".codex", "skills", SKILL_NAME) },
    { target: "claude", destinationPath: path.join(home, ".claude", "skills", SKILL_NAME) },
    { target: "opencode", destinationPath: path.join(home, ".config", "opencode", "skills", SKILL_NAME) },
  ]);
});

test("installManagedAgentSkills updates only previously managed unchanged skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-skills-update-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "resources", "agent-skills");
  writeSkill(sourceRoot, "Initial instructions");

  installManagedAgentSkills({ homeDir: home, sourceRoot, now: FIXED_NOW });
  writeSkill(sourceRoot, "Updated instructions");

  const results = installManagedAgentSkills({ homeDir: home, sourceRoot, now: new Date("2026-06-02T12:05:00.000Z") });

  assert.deepEqual(results.map((result) => result.status), ["updated", "updated", "updated"]);
  for (const target of managedSkillTargets(home)) {
    assert.equal(fs.readFileSync(path.join(target.destinationPath, "SKILL.md"), "utf8"), skillMarkdown("Updated instructions"));
  }
});

test("installManagedAgentSkills does not rewrite manifest when skills are unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-skills-unchanged-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "resources", "agent-skills");
  writeSkill(sourceRoot, "Initial instructions");

  installManagedAgentSkills({ homeDir: home, sourceRoot, now: FIXED_NOW });
  const manifestPath = path.join(home, ".context-workspace", "agent-skills.json");
  const manifestBefore = fs.readFileSync(manifestPath, "utf8");

  const results = installManagedAgentSkills({ homeDir: home, sourceRoot, now: new Date("2026-06-02T12:10:00.000Z") });

  assert.deepEqual(results.map((result) => result.status), ["unchanged", "unchanged", "unchanged"]);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
});

test("installManagedAgentSkills adopts manually synced copies that match the bundled skill", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-skills-adopt-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "resources", "agent-skills");
  writeSkill(sourceRoot, "Initial instructions");

  installManagedAgentSkills({ homeDir: home, sourceRoot, now: FIXED_NOW });

  // The user hand-syncs the upcoming release content into one skill directory.
  const claudeDestination = managedSkillTargets(home).find((target) => target.target === "claude")?.destinationPath;
  assert.ok(claudeDestination);
  fs.writeFileSync(path.join(claudeDestination, "SKILL.md"), skillMarkdown("Synced instructions"), "utf8");
  writeSkill(sourceRoot, "Synced instructions");

  const adopted = installManagedAgentSkills({ homeDir: home, sourceRoot, now: new Date("2026-06-02T12:05:00.000Z") });
  assert.deepEqual(adopted.map((result) => result.status), ["updated", "adopted", "updated"]);

  // The adopted copy must keep receiving managed updates afterwards.
  writeSkill(sourceRoot, "Later instructions");
  const updated = installManagedAgentSkills({ homeDir: home, sourceRoot, now: new Date("2026-06-02T12:10:00.000Z") });
  assert.deepEqual(updated.map((result) => result.status), ["updated", "updated", "updated"]);
  assert.equal(fs.readFileSync(path.join(claudeDestination, "SKILL.md"), "utf8"), skillMarkdown("Later instructions"));
});

test("installManagedAgentSkills skips user-owned or modified skill directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-skills-skip-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "resources", "agent-skills");
  writeSkill(sourceRoot, "Bundled instructions");

  const claudeDestination = managedSkillTargets(home).find((target) => target.target === "claude")?.destinationPath;
  assert.ok(claudeDestination);
  fs.mkdirSync(claudeDestination, { recursive: true });
  fs.writeFileSync(path.join(claudeDestination, "SKILL.md"), skillMarkdown("User instructions"), "utf8");

  const results = installManagedAgentSkills({ homeDir: home, sourceRoot, now: FIXED_NOW });

  assert.deepEqual(results.map((result) => result.status), ["installed", "skipped", "installed"]);
  assert.equal(fs.readFileSync(path.join(claudeDestination, "SKILL.md"), "utf8"), skillMarkdown("User instructions"));
});

function writeSkill(sourceRoot, body) {
  const directory = path.join(sourceRoot, "athena-context-workspace");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), skillMarkdown(body), "utf8");
}

function skillMarkdown(body) {
  return [
    "---",
    "name: athena-context-workspace",
    "description: Test skill",
    "---",
    "",
    body,
    "",
  ].join("\n");
}
