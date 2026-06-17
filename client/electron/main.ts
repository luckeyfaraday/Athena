import { app, BrowserWindow, Menu, dialog, shell, nativeImage, type MenuItemConstructorOptions, type NativeImage } from "electron";
import isDev from "electron-is-dev";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { hasPendingEmbeddedTerminalRestoreAttempts, prepareEmbeddedTerminalRestoreForQuit } from "./embedded-terminal.js";
import { startBackend, stopBackend } from "./backend.js";
import { startControlServer, stopControlServer } from "./control-server.js";
import { normalizeExternalUrl } from "./external-links.js";
import { beginAthenaLaunch, markAthenaCleanExit, pauseTerminalRestore } from "./launch-state.js";
import { checkDiskSpace, formatBytes, DISK_WARN_BYTES } from "./disk-guard.js";
import { installManagedAgentSkills } from "./agent-skills.js";
import { installAthenaCli } from "./athena-cli.js";
import { startAutoUpdates } from "./auto-update.js";
import type { IncomingMessage } from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

let mainWindow: BrowserWindow | null = null;
let viteProc: ChildProcess | null = null;

// Resolve the ATHENA app icon for the live window/taskbar/dock. The
// electron-builder `icon` config only brands the *packaged* bundle, so without
// this the running app (and dev `electron .`) falls back to the default
// Electron placeholder even though we ship the assets. Prefer the high-res PNG;
// `build/**` is bundled in packaged builds and present in the repo for dev.
function resolveAppIcon(): NativeImage | null {
  const candidates = [
    path.join(appRoot, "build", "icon-512.png"),
    path.join(appRoot, "build", "icon.png"),
    path.join(appRoot, "dist", "athena-icon-256.png"),
  ];
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      return image;
    }
  }
  return null;
}

const appIcon = resolveAppIcon();
const singleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true;

if (!singleInstanceLock) {
  app.quit();
}

function enableChromiumLogging(): void {
  try {
    const logPath = path.join(os.homedir(), ".context-workspace", "athena-chromium.log");
    app.commandLine.appendSwitch("enable-logging", "file");
    app.commandLine.appendSwitch("log-file", logPath);
    app.commandLine.appendSwitch("log-level", "0");
  } catch {
    // Logging setup is best-effort; never block startup over diagnostics.
  }
}

// Refuse to launch blindly into a near-full disk: Chromium mmaps its caches and
// the AppImage squashfs, and a write-back failure on a full volume raises an
// uncatchable SIGBUS that crash-loops the whole process tree. On critically low
// space we pause terminal restore (the most mmap/IO-heavy startup work) and warn
// the user so they can free space before continuing.
async function runDiskPreflight(): Promise<void> {
  try {
    const status = checkDiskSpace({ userDataDir: app.getPath("userData"), tempDir: os.tmpdir() });
    if (status.level === "ok") return;

    const free = formatBytes(status.freeBytes);
    if (status.level === "critical") {
      pauseTerminalRestore();
      console.error(`Low disk space (${free} free on ${status.path}); pausing terminal restore to avoid SIGBUS.`);
      await dialog.showMessageBox({
        type: "warning",
        title: "Low disk space",
        message: "Your disk is almost full.",
        detail:
          `Only ${free} is free on the volume holding Athena's data (${status.path}).\n\n`
          + "Athena may crash (SIGBUS) until you free up space. Saved terminals will not be "
          + `restored this session. Free at least ${formatBytes(DISK_WARN_BYTES)} and restart.`,
        buttons: ["Continue anyway"],
        defaultId: 0,
        noLink: true,
      });
    } else {
      console.warn(`Disk space is low (${free} free on ${status.path}).`);
    }
  } catch (error) {
    // Preflight is a safety net; a probe failure must never block startup.
    console.warn("Disk preflight check failed:", error);
  }
}

function shouldUseHeadlessGraphicsMode(): boolean {
  return process.env.CI === "true"
    || process.env.CONTEXT_WORKSPACE_HEADLESS === "1"
    || process.env.ELECTRON_DISABLE_GPU === "1";
}

function waitForVite(url: string, timeout = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    async function poll() {
      try {
        const http = await import("node:http");
        const req = http.get(url, (res: IncomingMessage) => {
          if (res.statusCode === 200) resolve();
        });
        req.on("error", retry);
      } catch (e) {
        retry();
      }
    }
    function retry() {
      if (Date.now() - start > timeout) {
        reject(new Error(`Vite did not start at ${url} within ${timeout}ms`));
      } else {
        setTimeout(poll, 500);
      }
    }
    poll();
  });
}

async function createWindow(): Promise<void> {
  void startBackend(appRoot).catch((error) => {
    console.error("Backend failed to start:", error);
  });

  const inDev = !app.isPackaged && isDev;
  if (inDev) {
    try {
      await waitForVite("http://127.0.0.1:5173/", 1000);
    } catch (e) {
      const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
      viteProc = spawn(npxCommand, ["vite", "--host", "127.0.0.1"], {
        cwd: appRoot,
        stdio: "pipe",
        detached: false,
        windowsHide: true,
      });
      viteProc.on("error", (error) => {
        console.error("Vite failed to start:", error);
        viteProc = null;
      });

      try {
        await waitForVite("http://127.0.0.1:5173/", 20000);
      } catch (error) {
        console.error("Vite failed to become ready:", error);
        if (viteProc) {
          viteProc.kill();
          viteProc = null;
        }
      }
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    ...(appIcon ? { icon: appIcon } : {}),
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#07120f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  installContextMenu(mainWindow);
  installExternalLinkHandler(mainWindow);

  if (inDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.join(appRoot, "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function installExternalLinkHandler(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl).catch((error) => {
        console.error("Failed to open external URL:", error);
      });
    }
    return { action: "deny" };
  });
}

// GPU-accelerated compositing in the browser process is the source of the
// recurring `segfault at 0 ip 0` crashes on Linux (flaky Mesa/Intel drivers
// call a null GL entry point). Disable hardware acceleration by default on
// Linux and in headless mode; CPU paint is slightly less smooth but stable.
// Set CONTEXT_WORKSPACE_ENABLE_GPU=1 to opt back in on machines with healthy
// drivers. These switches must be set before app.whenReady() / window creation.
app.commandLine.appendSwitch("no-sandbox");
const forceGpu = process.env.CONTEXT_WORKSPACE_ENABLE_GPU === "1";
if (!forceGpu && (process.platform === "linux" || shouldUseHeadlessGraphicsMode())) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-rasterization");
  app.disableHardwareAcceleration();
}

// Capture Chromium/GPU/V8 diagnostics to a file so the next crash leaves a
// real stack instead of a bare null-pointer core dump.
enableChromiumLogging();

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (singleInstanceLock) {
  app.whenReady().then(async () => {
    // macOS ignores the BrowserWindow `icon` option for the dock; set it here.
    if (process.platform === "darwin" && appIcon && app.dock) {
      app.dock.setIcon(appIcon);
    }
    beginAthenaLaunch({ restoreAttemptPending: hasPendingEmbeddedTerminalRestoreAttempts() });
    await runDiskPreflight();
    try {
      installManagedAgentSkills();
    } catch (error) {
      console.error("Failed to install managed agent skills:", error);
    }
    try {
      const cliResult = installAthenaCli();
      if (cliResult.status === "installed" || cliResult.status === "updated") {
        console.log(`Athena CLI shim ${cliResult.status} at ${cliResult.targetPath}`);
      } else if (cliResult.status === "skipped" || cliResult.status === "error" || cliResult.status === "missing-source") {
        console.warn(`Athena CLI shim ${cliResult.status}: ${cliResult.message ?? ""}`);
      }
    } catch (error) {
      console.error("Failed to install Athena CLI shim:", error);
    }
    installApplicationMenu();
    registerIpcHandlers(appRoot);
    void startControlServer().catch((error) => {
      console.error("Electron control server failed to start:", error);
    });
    await createWindow();
    startAutoUpdates();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  });
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const template: MenuItemConstructorOptions[] = process.platform === "darwin"
    ? [
        { role: "appMenu" },
        editMenu,
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]
    : [
        editMenu,
        { role: "viewMenu" },
      ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];

    if (params.editFlags.canUndo) template.push({ role: "undo" });
    if (params.editFlags.canRedo) template.push({ role: "redo" });
    if (template.length > 0) template.push({ type: "separator" });

    if (params.editFlags.canCut) template.push({ role: "cut" });
    if (params.editFlags.canCopy || params.selectionText.trim()) template.push({ role: "copy" });
    if (params.editFlags.canPaste) template.push({ role: "paste" });
    if (params.isEditable) template.push({ type: "separator" }, { role: "selectAll" });

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  markAthenaCleanExit();
  prepareEmbeddedTerminalRestoreForQuit();
  void stopBackend();
  void stopControlServer();
  if (viteProc) {
    viteProc.kill();
    viteProc = null;
  }
});
