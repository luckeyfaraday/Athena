import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

type Preferences = Record<string, string>;

function preferencesPath(): string {
  return path.join(app.getPath("userData"), "athena-preferences.json");
}

function readPreferencesFile(): Preferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writePreferencesFile(preferences: Preferences): void {
  const filePath = preferencesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(preferences, null, 2), "utf8");
}

export function getPreferences(): Preferences {
  return readPreferencesFile();
}

export function setPreference(key: string, value: string): Preferences {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("Preference key cannot be empty.");
  const preferences = readPreferencesFile();
  preferences[trimmedKey] = value;
  writePreferencesFile(preferences);
  return preferences;
}

export function removePreference(key: string): Preferences {
  const preferences = readPreferencesFile();
  delete preferences[key];
  writePreferencesFile(preferences);
  return preferences;
}
