import { app, dialog, shell } from "electron";
// electron-updater is CommonJS; named ESM imports fail at runtime under NodeNext.
import electronUpdater from "electron-updater";
import { resolveUpdateMode } from "./update-mode.js";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-check while the app stays open
const RELEASES_URL = "https://github.com/luckeyfaraday/Athena/releases/latest";

// Only prompt once per discovered version, not on every periodic re-check.
let promptedVersion: string | null = null;

export function startAutoUpdates(): void {
  const mode = resolveUpdateMode(process.platform, app.isPackaged);
  if (mode === "disabled") return;

  autoUpdater.autoDownload = mode === "auto-install";
  autoUpdater.autoInstallOnAppQuit = mode === "auto-install";

  autoUpdater.on("error", (error) => {
    // Update checks are best-effort: offline, rate-limited, or a missing
    // metadata file just means we try again on the next interval.
    console.warn("Auto-update check failed:", error instanceof Error ? error.message : error);
  });

  if (mode === "notify-only") {
    autoUpdater.on("update-available", (info) => {
      void promptManualDownload(info.version);
    });
  } else {
    autoUpdater.on("update-downloaded", (info) => {
      void promptRestart(info.version);
    });
  }

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn("Auto-update check failed:", error instanceof Error ? error.message : error);
    });
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}

async function promptRestart(version: string): Promise<void> {
  if (promptedVersion === version) return;
  promptedVersion = version;

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Update ready",
    message: `Athena ${version} has been downloaded.`,
    detail: "Restart to apply it now, or it will be installed automatically when you quit.",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    autoUpdater.quitAndInstall();
  }
}

async function promptManualDownload(version: string): Promise<void> {
  if (promptedVersion === version) return;
  promptedVersion = version;

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Update available",
    message: `Athena ${version} is available.`,
    detail: "macOS builds are unsigned, so the update can't install itself. Download the new version from GitHub.",
    buttons: ["Open download page", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    void shell.openExternal(RELEASES_URL).catch((error) => {
      console.error("Failed to open releases page:", error);
    });
  }
}
