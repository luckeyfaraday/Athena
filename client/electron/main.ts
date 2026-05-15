import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import isDev from "electron-is-dev";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { startBackend, stopBackend } from "./backend.js";
import { startControlServer, stopControlServer } from "./control-server.js";
import type { IncomingMessage } from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

let mainWindow: BrowserWindow | null = null;
let viteProc: ChildProcess | null = null;

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
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  installContextMenu(mainWindow);

  if (inDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.join(appRoot, "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Keep hardware acceleration enabled for normal desktop runs; xterm rendering
// and scrolling are noticeably worse when Electron is forced into CPU paint.
// These switches must be set before app.whenReady() and window creation.
app.commandLine.appendSwitch("no-sandbox");
if (shouldUseHeadlessGraphicsMode()) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-rasterization");
  app.disableHardwareAcceleration();
}

app.whenReady().then(async () => {
  installApplicationMenu();
  registerIpcHandlers(appRoot);
  void startControlServer().catch((error) => {
    console.error("Electron control server failed to start:", error);
  });
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

function installApplicationMenu(): void {
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
  void stopBackend();
  void stopControlServer();
  if (viteProc) {
    viteProc.kill();
    viteProc = null;
  }
});
