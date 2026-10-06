import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { CommandRoom } from "./CommandRoom";
import { WorkspaceTabs } from "../components/WorkspaceTabs";
import { RemoteFolderDialog } from "../components/RemoteFolderDialog";
import type { ConfirmRequest, TextPromptRequest } from "../components/PromptDialog";
import { desktop, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type RemoteMachineView, type WorkspacePath } from "../electron";
import {
  pickRemoteWorkspace,
  remoteLaunchError,
  remoteWorkspaceTabs,
  sessionsInWorkspace,
} from "../remote-view";
import type { WorkspaceAttention } from "../workspace-attention";
import { sameWorkspacePath, workspaceDisplayName, workspaceKey } from "../workspace-utils";

export type RemoteMachineRoomHandle = {
  launch: (kind: EmbeddedTerminalKind, count?: number) => void;
  switchWorkspaceBy: (offset: number) => void;
  goToWorkspace: (index: number) => void;
  openFolder: () => void;
  selectWorkspace: (workspace: string) => void;
  closeWorkspace: (workspace: string) => void;
  revealPane: (workspace: string, sessionId: string) => void;
};

export type RemoteRevealRequest = { workspace: string; sessionId: string; nonce: number };

const rememberedWorkspaceKey = (machineId: string) => `athena.remoteWorkspace.${machineId}`;

function readRememberedWorkspace(machineId: string): string | null {
  try {
    return window.localStorage.getItem(rememberedWorkspaceKey(machineId));
  } catch {
    return null;
  }
}

function rememberWorkspace(machineId: string, workspace: string | null): void {
  try {
    if (workspace) window.localStorage.setItem(rememberedWorkspaceKey(machineId), workspace);
    else window.localStorage.removeItem(rememberedWorkspaceKey(machineId));
  } catch {
    // Remembering the tab is a convenience; it is fine to lose it.
  }
}

// Another machine's Command Room: its workspace tabs and its terminals, which
// run there. Everything goes through main's remote client; the panes are the
// same EmbeddedTerminal components, fed by "remote:<machine>:<terminal>" ids.
export const RemoteMachineRoom = forwardRef<RemoteMachineRoomHandle, {
  machine: RemoteMachineView;
  switcher: ReactNode;
  attentionByWorkspace: Record<string, WorkspaceAttention>;
  revealRequest: RemoteRevealRequest | null;
  onRevealHandled: () => void;
  onActiveWorkspaceChange: (workspace: string | null) => void;
  onToast: (message: string) => void;
  onError: (message: string) => void;
  requestText: (request: TextPromptRequest) => Promise<string | null>;
  requestConfirm: (request: ConfirmRequest) => Promise<boolean>;
  emptyMark: ReactNode;
}>(function RemoteMachineRoom({
  machine,
  switcher,
  attentionByWorkspace,
  revealRequest,
  onRevealHandled,
  onActiveWorkspaceChange,
  onToast,
  onError,
  requestText,
  requestConfirm,
  emptyMark,
}, ref) {
  const [remembered, setRemembered] = useState<string | null>(() => readRememberedWorkspace(machine.id));
  const [busy, setBusy] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [revealPane, setRevealPane] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    setRemembered(readRememberedWorkspace(machine.id));
  }, [machine.id]);

  const tabs = useMemo(() => remoteWorkspaceTabs(machine), [machine]);
  const active = pickRemoteWorkspace(tabs, remembered, machine.activeWorkspace);
  const activePath = active?.nativePath ?? "";

  useEffect(() => {
    onActiveWorkspaceChange(activePath || null);
  }, [activePath, onActiveWorkspaceChange]);

  // A notification click for this machine: show that workspace and pane.
  useEffect(() => {
    if (!revealRequest) return;
    selectWorkspace(revealRequest.workspace);
    setRevealPane({ id: revealRequest.sessionId, nonce: revealRequest.nonce });
    onRevealHandled();
  }, [revealRequest]);

  function selectWorkspace(workspace: string) {
    setRemembered(workspace);
    rememberWorkspace(machine.id, workspace);
  }

  async function launch(kind: EmbeddedTerminalKind, count = 1) {
    if (!activePath || busy) return;
    if (machine.connection !== "connected") {
      onToast(`Still connecting to ${machine.name}…`);
      return;
    }
    setBusy(true);
    try {
      const created = await desktop.spawnRemoteTerminals(machine.id, { workspace: activePath, kind, count });
      if (count > 1) setLayoutResetNonce((value) => value + 1);
      if (created[0]) setRevealPane({ id: created[0].id, nonce: Date.now() });
    } catch (error) {
      onError(remoteLaunchError(error, machine.name));
    } finally {
      setBusy(false);
    }
  }

  async function closeTerminal(id: string) {
    try {
      await desktop.killEmbeddedTerminal(id);
    } catch (error) {
      onError(remoteLaunchError(error, machine.name));
    }
  }

  async function renameTerminal(session: EmbeddedTerminalSession) {
    const title = await requestText({ title: "Rename pane", initialValue: session.title, confirmLabel: "Rename" });
    if (!title || title === session.title) return;
    await desktop.renameEmbeddedTerminal(session.id, title).catch((error) => onError(remoteLaunchError(error, machine.name)));
  }

  async function closeWorkspace(tab: WorkspacePath) {
    const running = sessionsInWorkspace(machine.sessions, tab.nativePath).filter((session) => session.status === "running").length;
    if (running > 0) {
      const confirmed = await requestConfirm({
        title: `Close ${workspaceDisplayName(tab)} on ${machine.name}?`,
        message: `This stops ${running} terminal${running === 1 ? "" : "s"} running there and closes the tab in ${machine.name}'s Athena too.`,
        confirmLabel: "Close and stop",
      });
      if (!confirmed) return;
    }
    try {
      await desktop.closeRemoteWorkspace(machine.id, tab.nativePath);
      if (sameWorkspacePath(tab.nativePath, activePath)) {
        const next = tabs.find((candidate) => !sameWorkspacePath(candidate.nativePath, tab.nativePath));
        selectWorkspace(next?.nativePath ?? "");
      }
    } catch (error) {
      onError(remoteLaunchError(error, machine.name));
    }
  }

  async function openFolder(path: string) {
    const opened = await desktop.openRemoteWorkspace(machine.id, path);
    selectWorkspace(opened.nativePath);
    setFolderDialog(false);
  }

  function switchBy(offset: number) {
    if (tabs.length < 2 || !active) return;
    const index = tabs.findIndex((tab) => workspaceKey(tab) === workspaceKey(active));
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (next) selectWorkspace(next.nativePath);
  }

  useImperativeHandle(ref, () => ({
    launch: (kind, count) => void launch(kind, count),
    switchWorkspaceBy: switchBy,
    goToWorkspace: (index) => {
      const tab = tabs[index];
      if (tab) selectWorkspace(tab.nativePath);
    },
    openFolder: () => setFolderDialog(true),
    selectWorkspace,
    closeWorkspace: (workspace) => {
      const tab = tabs.find((candidate) => sameWorkspacePath(candidate.nativePath, workspace));
      if (tab) void closeWorkspace(tab);
    },
    revealPane: (workspace, sessionId) => {
      selectWorkspace(workspace);
      setRevealPane({ id: sessionId, nonce: Date.now() });
    },
  }));

  const connectionNotice = machine.status !== "ready"
    ? `${machine.name} is no longer answering. Its terminals keep running there; this view reconnects when it's back.`
    : machine.connection === "error"
      ? `Lost the connection to ${machine.name}${machine.connectionError ? ` (${machine.connectionError})` : ""}. Reconnecting…`
      : machine.connection !== "connected"
        ? `Connecting to ${machine.name}…`
        : null;

  return (
    <>
      {connectionNotice && (
        <div className="noticeBar remoteNotice" role="status">
          <AlertTriangle size={15} />
          <span>{connectionNotice}</span>
        </div>
      )}
      <WorkspaceTabs
        className="remoteWorkspaceTabs"
        leading={switcher}
        workspaces={tabs}
        activeWorkspace={active}
        terminalSessions={machine.sessions}
        attentionByWorkspace={attentionByWorkspace}
        addTitle={`Open a folder on ${machine.name}`}
        emptyText={`No folders open on ${machine.name} yet.`}
        onSelect={(tab) => selectWorkspace(tab.nativePath)}
        onClose={(tab) => void closeWorkspace(tab)}
        onAdd={async () => setFolderDialog(true)}
      />
      <CommandRoom
        key={machine.id}
        workspace={activePath}
        sessions={machine.sessions}
        agentSessions={[]}
        busy={busy}
        layoutResetNonce={layoutResetNonce}
        interfaceMode="terminal"
        view="terminals"
        onViewChange={() => undefined}
        revealPaneRequest={revealPane}
        onRevealPaneHandled={() => setRevealPane(null)}
        onInterfaceModeChange={() => undefined}
        onToast={onToast}
        onAddWorkspace={() => setFolderDialog(true)}
        onLaunch={launch}
        onClose={closeTerminal}
        onResumeSession={async () => undefined}
        onRenameEmbeddedSession={(session) => void renameTerminal(session)}
        onRenameAgentSession={() => undefined}
        onRefreshAgentSessions={async () => undefined}
        emptyMark={emptyMark}
        remoteMachine={{ name: machine.name }}
      />
      {folderDialog && (
        <RemoteFolderDialog
          machineId={machine.id}
          machineName={machine.name}
          initialPath={machine.homedir}
          onOpen={openFolder}
          onCancel={() => setFolderDialog(false)}
        />
      )}
    </>
  );
});
