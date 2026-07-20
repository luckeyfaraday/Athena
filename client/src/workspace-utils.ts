import type { WorkspacePath } from "./electron";

export function normalizeWorkspaceKey(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/");
  if (!slashed) return "";
  const wslDrive = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(slashed);
  if (wslDrive) {
    const rest = (wslDrive[2] ?? "").replace(/\/+$/, "");
    return `${wslDrive[1]}:/${rest}`.toLowerCase();
  }
  const windowsDrive = /^\/?([a-zA-Z]):\/(.*)$/.exec(slashed);
  if (windowsDrive) {
    const rest = windowsDrive[2].replace(/\/+$/, "");
    return `${windowsDrive[1]}:/${rest}`.toLowerCase();
  }
  const withoutTrailingSlashes = slashed.replace(/\/+$/, "");
  const normalized = withoutTrailingSlashes || (slashed.startsWith("/") ? "/" : "");
  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) return normalized.toLowerCase();
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
