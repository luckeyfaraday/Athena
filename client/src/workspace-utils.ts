import type { WorkspacePath } from "./electron";

export function normalizeWorkspaceKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
