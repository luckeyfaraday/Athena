import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App";
import { desktop, type EmbeddedTerminalSession, type RemoteMachineView, type WorkspacePath } from "../../src/electron";
import "../../src/styles/tokens.css";
import "../../src/styles/themes.css";
import "../../src/styles.css";

const workspace = (nativePath: string): WorkspacePath => ({ nativePath, displayPath: nativePath, wslPath: null });
const local = workspace("/local/project");
const remote = workspace("/remote/project");
const session = (id: string, path: string): EmbeddedTerminalSession => ({
  id, workspace: path, title: id, kind: "shell", status: "running", pid: 100,
  promptPath: null, initialTask: null, sessionLabel: null, providerSessionId: null,
  createdAt: new Date().toISOString(), exitCode: null, error: null,
});
const localSession = session("local-job", local.nativePath);
const machine: RemoteMachineView = {
  id: "desktop", name: "omarchy", dnsName: null, os: "linux", online: true,
  address: "100.64.0.2", url: "http://100.64.0.2:47821", owner: null, ownDevice: true,
  status: "ready", detail: null, version: "0.4.0", platform: "linux", homedir: "/remote", checkedAt: null,
  connection: "connected", connectionError: null, hasToken: true,
  workspaces: [remote, workspace("/remote/other")], activeWorkspace: remote,
  sessions: [session("remote:desktop:remote-job", remote.nativePath)],
};
const state = (window as any).remoteAppTest = {
  killed: [] as string[], closed: [] as unknown[], spawns: [] as unknown[], directories: [] as unknown[],
};
Object.assign(desktop, {
  getPreferences: async () => ({
    "context-workspace:lastWorkspace": JSON.stringify(local),
    "context-workspace:workspaces": JSON.stringify([local, workspace("/local/other")]),
  }),
  getDefaultWorkspace: async () => local,
  listEmbeddedTerminals: async () => [localSession],
  restoreEmbeddedTerminals: async () => [localSession],
  listAgentSessions: async () => [],
  killEmbeddedTerminal: async (id: string) => {
    state.killed.push(id);
    return { ...localSession, status: "exited" };
  },
  getRemoteSnapshot: async () => ({ tailscale: "running", account: null, selfName: "viewer", refreshedAt: null, machines: [machine] }),
  closeRemoteWorkspace: async (...args: unknown[]) => { state.closed.push(args); },
  spawnRemoteTerminals: async (...args: unknown[]) => { state.spawns.push(args); return []; },
  listRemoteDirectories: async (...args: unknown[]) => {
    state.directories.push(args);
    return { path: "/remote", parent: "/", home: "/remote", dirs: [], truncated: false };
  },
});
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
