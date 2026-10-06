import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { CommandRoom } from "./CommandRoom";
import { WorkspaceTabs } from "../components/WorkspaceTabs";
import { RemoteFolderDialog } from "../components/RemoteFolderDialog";
import type { ConfirmRequest, TextPromptRequest } from "../components/PromptDialog";
import { desktop, type AgentSession, type EmbeddedTerminalKind, type EmbeddedTerminalSession, type RemoteMachineView, type WorkspacePath } from "../electron";
import { useRemoteSessionHistory } from "../use-remote-session-history";
import { applyAgentSessionRenames, providerLabel, readRenamedSessions, selectedAgentSessionKey, writeRenamedSessions } from "../session-utils";
import {
  pickRemoteWorkspace,
  remoteLaunchError,
  remoteWorkspaceTabs,
  sessionsInWorkspace,
} from "../remote-view";
import type { WorkspaceAttention } from "../workspace-attention";
import { sameWorkspacePath, workspaceDisplayName, workspaceKey } from "../workspace-utils";

export type RemoteMachineRoomHandle = {
  showView: (view: "sessions" | "terminals") => void;
  toggleSessions: () => void;
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
  const launchPending = useRef(false);
  const [view, setView] = useState<"terminals" | "sessions">("terminals");
  const [renameVersion, setRenameVersion] = useState(0);
  const [folderDialog, setFolderDialog] = useState(false);
  const [layoutResetNonce, setLayoutResetNonce] = useState(0);
  const [revealPane, setRevealPane] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    setRemembered(readRememberedWorkspace(machine.id));
  }, [machine.id]);

  const tabs = useMemo(() => remoteWorkspaceTabs(machine), [machine]);
  const active = pickRemoteWorkspace(tabs, remembered, machine.activeWorkspace);
  const activePath = active?.nativePath ?? "";
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const history = useRemoteSessionHistory(machine.id, activePath, view === "sessions");
  const agentSessions = useMemo(() => {
    const renames = readRenamedSessions(`remote:${machine.id}:${activePath}`);
    const sessions = history.sessions.map((session) => {
      const live = machine.sessions.find((terminal) => terminal.kind === session.provider
        && terminal.providerSessionId === session.id && sameWorkspacePath(terminal.workspace, session.workspace));
      return live ? { ...session, terminalId: live.id, status: live.status === "running" ? "running" as const : "exited" as const } : session;
    });
    return applyAgentSessionRenames(sessions, renames);
  }, [history.sessions, machine.sessions, machine.id, activePath, renameVersion]);

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
    if (!activePath || launchPending.current) return;
    if (machine.connection !== "connected") {
      onToast(`Still connecting to ${machine.name}…`);
      return;
    }
    launchPending.current = true;
    setBusy(true);
    try {
      const created = await desktop.spawnRemoteTerminals(machine.id, { workspace: activePath, kind, count });
      if (activePathRef.current !== activePath) return;
      setView("terminals");
      if (count > 1) setLayoutResetNonce((value) => value + 1);
      if (created[0]) setRevealPane({ id: created[0].id, nonce: Date.now() });
    } catch (error) {
      onError(remoteLaunchError(error, machine.name));
    } finally {
      launchPending.current = false;
      setBusy(false);
    }
  }

  async function resumeSession(session: AgentSession): Promise<boolean> {
    if (launchPending.current || !history.sessions.some((row) => row.id === session.id
      && row.provider === session.provider && row.workspace === session.workspace)) return false;
    if (machine.connection !== "connected") {
      onToast(`Still connecting to ${machine.name}…`);
      return false;
    }
    launchPending.current = true;
    setBusy(true);
    try {
      const created = await desktop.spawnRemoteTerminals(machine.id, {
        workspace: session.workspace, kind: session.provider, count: 1,
        title: `${providerLabel(session.provider)} Resume`, resumeSessionId: session.id, sessionLabel: session.title,
      });
      if (!created[0]) throw new Error(`${machine.name} did not return a resumed terminal. Check its terminals before trying again.`);
      if (activePathRef.current !== activePath) return false;
      selectWorkspace(session.workspace);
      if (created[0]) setRevealPane({ id: created[0].id, nonce: Date.now() });
      return true;
    } catch (error) {
      onError(remoteLaunchError(error, machine.name));
      return false;
    } finally {
      launchPending.current = false;
      setBusy(false);
    }
  }

  async function renameAgentSession(session: AgentSession) {
    const key = `remote:${machine.id}:${activePath}`;
    const title = await requestText({ title: "Rename session", initialValue: session.title, confirmLabel: "Rename" });
    if (!title || title === session.title) return;
    writeRenamedSessions(key, { ...readRenamedSessions(key), [selectedAgentSessionKey(session)]: title });
    setRenameVersion((version) => version + 1);
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
    showView: setView,
    toggleSessions: () => setView((current) => current === "sessions" ? "terminals" : "sessions"),
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
        agentSessions={agentSessions}
        busy={busy}
        layoutResetNonce={layoutResetNonce}
        interfaceMode="terminal"
        view={view}
        onViewChange={setView}
        revealPaneRequest={revealPane}
        onRevealPaneHandled={() => setRevealPane(null)}
        onInterfaceModeChange={() => undefined}
        onToast={onToast}
        onAddWorkspace={() => setFolderDialog(true)}
        onLaunch={launch}
        onClose={closeTerminal}
        onResumeSession={resumeSession}
        onFocusAgentSession={(session) => {
          selectWorkspace(session.workspace);
          setView("terminals");
          if (session.terminalId) setRevealPane({ id: session.terminalId, nonce: Date.now() });
        }}
        onRenameEmbeddedSession={(session) => void renameTerminal(session)}
        onRenameAgentSession={(session) => void renameAgentSession(session)}
        onRefreshAgentSessions={history.refresh}
        sessionHistoryLoading={history.loading}
        sessionHistoryMessage={history.message}
        onLoadMoreSessions={history.loadMore}
        emptyMark={emptyMark}
        remoteMachine={{ id: machine.id, name: machine.name }}
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
