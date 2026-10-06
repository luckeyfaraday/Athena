import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App";
import { desktop, type AgentSession, type EmbeddedTerminalSession, type RemoteMachineView, type RemoteSnapshot, type RemoteSpawnRequest, type WorkspacePath } from "../../src/electron";
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
  historyCalls: [] as unknown[], historyDelay: false, historyResolvers: [] as (() => void)[], historyError: null as string | null,
  spawnError: null as string | null, spawnDelay: false, spawnResolvers: [] as (() => void)[],
  historySubfolder: false,
};
const machines = [machine, { ...machine, id: "second", name: "travel", sessions: [] }];
const snapshot = (): RemoteSnapshot => ({ tailscale: "running", account: null, selfName: "viewer", refreshedAt: null, machines: machines.map((item) => ({ ...item })) });
let onUpdate: ((value: RemoteSnapshot) => void) | null = null;
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
  getRemoteSnapshot: async () => snapshot(),
  onRemoteUpdate: (callback: (value: RemoteSnapshot) => void) => { onUpdate = callback; return () => { onUpdate = null; }; },
  listRemoteAgentSessions: async (machineId: string, path: string, cursor: string | null) => {
    state.historyCalls.push([machineId, path, cursor]);
    if (state.historyDelay) await new Promise<void>((resolve) => state.historyResolvers.push(resolve));
    if (state.historyError) throw new Error(state.historyError);
    const id = `${path}:${cursor || "first"}`;
    const row: AgentSession = {
      id, title: `History ${machineId}:${id}`, provider: "claude", workspace: state.historySubfolder ? `${path}/child` : path, branch: null, model: null, agent: null,
      status: "historical", terminalId: null, pid: null, resumeCommand: `claude --resume ${id}`,
      createdAt: "2026-10-01", updatedAt: "2026-10-02", metadata: {},
    };
    return { sessions: [row], nextCursor: cursor ? null : "page2", warning: null };
  },
  closeRemoteWorkspace: async (...args: unknown[]) => { state.closed.push(args); },
  spawnRemoteTerminals: async (id: string, request: RemoteSpawnRequest) => {
    state.spawns.push([id, request]);
    if (state.spawnDelay) await new Promise<void>((resolve) => state.spawnResolvers.push(resolve));
    if (state.spawnError) throw new Error(state.spawnError);
    if (!request.resumeSessionId) return [];
    const created = { ...session(`remote:${id}:resumed`, request.workspace), kind: request.kind, providerSessionId: request.resumeSessionId };
    const target = machines.find((item) => item.id === id)!;
    target.sessions = [...target.sessions, created];
    onUpdate?.(snapshot());
    return [created];
  },
  listRemoteDirectories: async (...args: unknown[]) => {
    state.directories.push(args);
    return { path: "/remote", parent: "/", home: "/remote", dirs: [], truncated: false };
  },
});
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
