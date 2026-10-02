// Helpers for viewing another machine's Athena (the machine switcher and the
// remote Command Room). Pure functions only, so they can be unit tested in Node.

import type { EmbeddedTerminalSession, RemoteMachineView, RemoteSnapshot, WorkspacePath } from "./electron";
import type { WorkspaceAttention } from "./workspace-attention";
import { normalizeWorkspaceKey, sameWorkspacePath } from "./workspace-utils.ts";

export const REMOTE_TERMINAL_PREFIX = "remote:";

export function isRemoteSessionId(id: string): boolean {
  return id.startsWith(REMOTE_TERMINAL_PREFIX);
}

/** The machine id inside a "remote:<machine>:<terminal>" id. */
export function remoteMachineIdOf(id: string): string | null {
  if (!isRemoteSessionId(id)) return null;
  const rest = id.slice(REMOTE_TERMINAL_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon > 0 ? rest.slice(0, colon) : null;
}

/** A remote path as a tab; the remote machine already normalized it. */
export function remoteWorkspacePath(nativePath: string): WorkspacePath {
  return { nativePath, wslPath: null, displayPath: nativePath };
}

/**
 * The tabs to show for a remote machine: the ones its own window has open,
 * then any folder a terminal there runs in that has no tab.
 */
export function remoteWorkspaceTabs(machine: RemoteMachineView): WorkspacePath[] {
  const tabs = [...machine.workspaces];
  for (const session of machine.sessions) {
    if (!session.workspace || tabs.some((tab) => sameWorkspacePath(tab.nativePath, session.workspace))) continue;
    tabs.push(remoteWorkspacePath(session.workspace));
  }
  return tabs;
}

/** The tab to show: the last one picked here if it still exists, else the machine's own active tab, else the first. */
export function pickRemoteWorkspace(tabs: WorkspacePath[], remembered: string | null, machineActive: WorkspacePath | null): WorkspacePath | null {
  const rememberedTab = remembered ? tabs.find((tab) => sameWorkspacePath(tab.nativePath, remembered)) : undefined;
  if (rememberedTab) return rememberedTab;
  const activeTab = machineActive ? tabs.find((tab) => sameWorkspacePath(tab.nativePath, machineActive.nativePath)) : undefined;
  return activeTab ?? tabs[0] ?? null;
}

export type SwitcherEntry = {
  id: string;
  name: string;
  /** Can be opened now. */
  available: boolean;
  /** Short state shown next to the name. */
  state: string;
  running: number;
  os: string | null;
};

/**
 * Machines worth listing in the switcher: ready ones, ones that only need a
 * token (so the switcher can say so), and the one being viewed even if it just
 * went away. Offline and Athena-less machines are left to Settings.
 */
export function switcherEntries(snapshot: RemoteSnapshot | null, activeMachineId: string | null): SwitcherEntry[] {
  if (!snapshot) return [];
  return snapshot.machines
    .filter((machine) => machine.status === "ready" || machine.status === "needs-token" || machine.id === activeMachineId)
    .map((machine) => ({
      id: machine.id,
      name: machine.name,
      available: machine.status === "ready",
      state: switcherState(machine),
      running: machine.sessions.filter((session) => session.status === "running").length,
      os: machine.os,
    }));
}

function switcherState(machine: RemoteMachineView): string {
  if (machine.status === "needs-token") return "Needs token";
  if (machine.status !== "ready") return machine.status === "offline" ? "Offline" : "Not answering";
  if (machine.connection === "connecting" || machine.connection === "idle") return "Connecting…";
  if (machine.connection === "error") return "Reconnecting…";
  const running = machine.sessions.filter((session) => session.status === "running").length;
  return running ? `${running} running` : "Idle";
}

/** True when the switcher is worth showing at all. */
export function hasRemoteMachines(snapshot: RemoteSnapshot | null, activeMachineId: string | null): boolean {
  return switcherEntries(snapshot, activeMachineId).length > 0;
}

/** Attention badges and notification routing key for a remote workspace. */
export function remoteAttentionKey(machineId: string, workspace: string): string {
  return `${REMOTE_TERMINAL_PREFIX}${machineId}:${normalizeWorkspaceKey(workspace)}`;
}

/** One machine's attention badges, keyed the way WorkspaceTabs looks them up. */
export function machineWorkspaceAttention(
  attention: Record<string, WorkspaceAttention>,
  machineId: string,
): Record<string, WorkspaceAttention> {
  const prefix = `${REMOTE_TERMINAL_PREFIX}${machineId}:`;
  const result: Record<string, WorkspaceAttention> = {};
  for (const [key, value] of Object.entries(attention)) {
    if (key.startsWith(prefix)) result[normalizeWorkspaceKey(key.slice(prefix.length))] = value;
  }
  return result;
}

export function sessionsInWorkspace(sessions: EmbeddedTerminalSession[], workspace: string): EmbeddedTerminalSession[] {
  return sessions.filter((session) => sameWorkspacePath(session.workspace, workspace));
}

/** A friendlier message for a failed remote launch. */
export function remoteLaunchError(error: unknown, machineName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
  if (/not installed or not on PATH/i.test(cleaned)) return `${cleaned.replace(/\.$/, "")} on ${machineName}.`;
  if (/did not answer in time|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|socket hang up/i.test(cleaned)) {
    return `${machineName} stopped answering. Check that Athena is still running there.`;
  }
  return cleaned;
}
