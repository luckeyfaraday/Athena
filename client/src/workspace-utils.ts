import type { WorkspacePath } from "./electron";

export function normalizeWorkspaceKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const wslDrive = /^\/mnt\/([a-zA-Z])\/(.+)$/.exec(normalized);
  if (wslDrive) return `${wslDrive[1]}:/${wslDrive[2]}`.toLowerCase();
  const windowsDrive = /^\/?([a-zA-Z]):\/(.+)$/.exec(normalized);
  if (windowsDrive) return `${windowsDrive[1]}:/${windowsDrive[2]}`.toLowerCase();
  return normalized;
}

export function sameWorkspacePath(left: string, right: string): boolean {
  return Boolean(left && right && normalizeWorkspaceKey(left) === normalizeWorkspaceKey(right));
}

export function workspaceDisplayName(workspace: WorkspacePath): string {
  const normalized = workspace.displayPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? workspace.displayPath;
}

export function workspaceKey(workspace: WorkspacePath): string {
  return normalizeWorkspaceKey(workspace.nativePath);
}
