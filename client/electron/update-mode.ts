// Pure decision logic for the in-app updater, split out so tests can run it
// without loading Electron.

export type UpdateMode = "auto-install" | "notify-only" | "disabled";

export function resolveUpdateMode(platform: NodeJS.Platform, isPackaged: boolean): UpdateMode {
  // Dev builds have no app-update.yml and nothing meaningful to update.
  if (!isPackaged) return "disabled";
  // macOS builds are unsigned, and Squirrel.Mac refuses to swap in an unsigned
  // bundle — so we can detect new releases but not install them in place.
  if (platform === "darwin") return "notify-only";
  return "auto-install";
}
