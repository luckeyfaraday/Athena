import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installManagedAgentSkills, managedSkillTargets } from "../dist-electron/agent-skills.js";

const FIXED_NOW = new Date("2026-06-02T12:00:00.000Z");

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
