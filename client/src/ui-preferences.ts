import { desktop, type WorkspacePath } from "./electron";
import {
  defaultNotificationPreferences,
  parseNotificationPreferences,
  serializeNotificationPreferences,
  type NotificationPreferences,
} from "./workspace-attention";
import { parseThemePreference, type ThemePreference } from "./themes";
import { workspaceKey } from "./workspace-utils";

export type InterfaceMode = "terminal" | "chat";
export type UiTheme = ThemePreference;
export type Density = "compact" | "default" | "comfortable";

export const workspaceStorageKey = "context-workspace:lastWorkspace";
export const workspaceListStorageKey = "context-workspace:workspaces";
export const interfaceModeStorageKey = "context-workspace:interfaceMode";
export const uiThemeStorageKey = "context-workspace:uiTheme";
export const notificationsStorageKey = "context-workspace:notifications";
export const densityStorageKey = "context-workspace:density";

const maxWorkspaceTabs = 12;

export function storedValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; Electron preferences remain authoritative.
  }
  void desktop.setPreference(key, value).catch(() => undefined);
}

function removeStorageValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; Electron preferences remain authoritative.
  }
  void desktop.removePreference(key).catch(() => undefined);
}

export function parseStoredWorkspace(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspacePath>;
    return parsed.nativePath || null;
  } catch {
    return value;
  }
}

export function writeStoredWorkspace(workspacePath: WorkspacePath | null): void {
  if (workspacePath?.nativePath.trim()) writeStorageValue(workspaceStorageKey, JSON.stringify(workspacePath));
  else removeStorageValue(workspaceStorageKey);
}

export function readWorkspaceListValue(value: string | null): WorkspacePath[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as Partial<WorkspacePath>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WorkspacePath =>
      typeof item?.nativePath === "string" &&
      typeof item.displayPath === "string" &&
      (typeof item.wslPath === "string" || item.wslPath === null),
    );
  } catch {
    return [];
  }
}

export function readWorkspaceList(): WorkspacePath[] {
  return readWorkspaceListValue(storedValue(workspaceListStorageKey));
}

export function writeWorkspaceList(workspaces: WorkspacePath[]): void {
  writeStorageValue(workspaceListStorageKey, JSON.stringify(workspaces));
}

export function upsertWorkspace(workspaces: WorkspacePath[], workspace: WorkspacePath): WorkspacePath[] {
  const key = workspaceKey(workspace);
  return [workspace, ...workspaces.filter((item) => workspaceKey(item) !== key)].slice(0, maxWorkspaceTabs);
}

export function parseInterfaceMode(value: string | null): InterfaceMode | null {
  if (value === "chat" || value === "terminal") return value;
  return null;
}

export function readInterfaceMode(): InterfaceMode {
  return parseInterfaceMode(storedValue(interfaceModeStorageKey)) ?? "terminal";
}

export function writeInterfaceMode(mode: InterfaceMode): void {
  writeStorageValue(interfaceModeStorageKey, mode);
}

export function parseUiTheme(value: string | null): UiTheme | null {
  return parseThemePreference(value);
}

export function readUiTheme(): UiTheme {
  return parseUiTheme(storedValue(uiThemeStorageKey)) ?? "classic";
}

export function writeUiTheme(theme: UiTheme): void {
  writeStorageValue(uiThemeStorageKey, theme);
}

export function parseDensity(value: string | null): Density | null {
  if (value === "compact" || value === "default" || value === "comfortable") return value;
  return null;
}

export function readDensity(): Density {
  return parseDensity(storedValue(densityStorageKey)) ?? "default";
}

export function writeDensity(density: Density): void {
  writeStorageValue(densityStorageKey, density);
}

export function readNotificationPreferences(): NotificationPreferences {
  return parseNotificationPreferences(storedValue(notificationsStorageKey)) ?? defaultNotificationPreferences;
}

export function writeNotificationPreferences(preferences: NotificationPreferences): void {
  writeStorageValue(notificationsStorageKey, serializeNotificationPreferences(preferences));
}
