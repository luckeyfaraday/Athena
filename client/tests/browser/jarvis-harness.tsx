import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App";
import { desktop, type EmbeddedTerminalSession, type JarvisState, type WorkspacePath } from "../../src/electron";
import "../../src/styles/tokens.css";
import "../../src/styles/themes.css";
import "../../src/styles.css";

// ?licensed=0 renders an Athena without a Jarvis license; ?theme=<id> picks the theme.
const params = new URLSearchParams(window.location.search);
const local: WorkspacePath = { nativePath: "/local/project", displayPath: "/local/project", wslPath: null };
const session = (id: string, kind: EmbeddedTerminalSession["kind"]): EmbeddedTerminalSession => ({
  id, workspace: local.nativePath, title: id, kind, status: "running", pid: 100,
  promptPath: null, initialTask: null, sessionLabel: null, providerSessionId: null,
  createdAt: new Date().toISOString(), exitCode: null, error: null,
});
const sessions = [session("Codex", "codex"), session("Claude", "claude")];
const licensed = params.get("licensed") !== "0";

let jarvis: JarvisState = {
  license: licensed
    ? { licensed: true, detail: null, offlineUntil: Date.now() + 21 * 86_400_000, licenseId: "lic-1", keyMasked: "JARV-••••-••••-7Q2K", instanceName: "omarchy" }
    : { licensed: false, detail: "Jarvis is not activated on this computer", offlineUntil: null, licenseId: null, keyMasked: null, instanceName: null },
  installPath: "C:\\Users\\alan\\AppData\\Local\\Jarvis AI\\jarvis-hud.exe",
  running: false,
  connected: false,
  micOpen: null,
  activity: "idle",
  partial: null,
  provider: null,
  model: null,
  agents: [],
  feed: [],
  lastError: null,
  updatedAt: Date.now(),
};
let listener: ((state: JarvisState) => void) | null = null;
const state = (window as any).jarvisTest = {
  asks: [] as string[], mics: [] as string[], launches: 0, askError: null as string | null,
  preferences: [] as Array<[string, string]>,
  push: (patch: Partial<JarvisState>) => {
    jarvis = { ...jarvis, ...patch, updatedAt: Date.now() };
    listener?.(jarvis);
  },
};

Object.assign(desktop, {
  getPreferences: async () => ({
    "context-workspace:lastWorkspace": JSON.stringify(local),
    "context-workspace:workspaces": JSON.stringify([local]),
    ...(params.get("theme") ? { "context-workspace:uiTheme": params.get("theme") } : {}),
  }),
  setPreference: async (key: string, value: string) => {
    state.preferences.push([key, value]);
    return {};
  },
  getDefaultWorkspace: async () => local,
  listEmbeddedTerminals: async () => sessions,
  restoreEmbeddedTerminals: async () => sessions,
  getJarvisState: async () => jarvis,
  refreshJarvis: async () => jarvis,
  onJarvisState: (callback: (next: JarvisState) => void) => {
    listener = callback;
    return () => { listener = null; };
  },
  launchJarvis: async () => {
    state.launches++;
    return jarvis;
  },
  setJarvisMic: async (mic: "on" | "off" | "toggle") => {
    state.mics.push(mic);
    jarvis = { ...jarvis, micOpen: mic === "toggle" ? !jarvis.micOpen : mic === "on", updatedAt: Date.now() };
    return jarvis;
  },
  askJarvis: async (text: string) => {
    if (state.askError) throw new Error(state.askError);
    state.asks.push(text);
    jarvis = { ...jarvis, feed: [...jarvis.feed, { id: jarvis.feed.length + 1, at: Date.now(), kind: "asked", text, agent: "athena" }], updatedAt: Date.now() };
    return jarvis;
  },
});
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
