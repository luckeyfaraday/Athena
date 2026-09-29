import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/tokens.css";
import "../../src/styles/themes.css";
import "../../src/styles.css";

const listeners = new Set<(payload: unknown) => void>();
const exitListeners = new Set<(payload: unknown) => void>();
const session = {
  id: "chat-test", title: "Codex", kind: "codex", workspace: "C:/project", pid: 1,
  promptPath: null, initialTask: null, sessionLabel: null, providerSessionId: "native-test",
  createdAt: new Date().toISOString(), status: "running", exitCode: null, error: null,
};
const state = (window as any).chatTest = {
  writes: [] as string[], failWrite: false, failAttach: false, attaches: 0, sequence: 0, commits: 0, buffer: "",
  emit(data: string, epoch = "test") {
    const sequence = ++state.sequence;
    state.buffer += data;
    for (const listener of listeners) listener({ id: session.id, epoch, sequence, fromSequence: sequence, reset: false, data });
  },
  emitExit(payload: object) {
    for (const listener of exitListeners) listener({ id: session.id, epoch: "test", exitCode: 0, ...payload });
  },
};
(window as any).contextWorkspace = {
  getBackendState: async () => ({ baseUrl: window.location.origin, healthy: true }),
  getGraphicsStatus: async () => ({ mode: "safe" }),
  writeEmbeddedTerminal: async (_id: string, data: string) => {
    if (state.failWrite) throw new Error("PTY disconnected");
    state.writes.push(data);
    return session;
  },
  attachEmbeddedTerminalStream: async () => {
    state.attaches++;
    if (state.failAttach) throw new Error("Stream disconnected");
    return { id: session.id, epoch: "test", throughSequence: state.sequence, buffer: state.buffer };
  },
  onEmbeddedTerminalDataFor: (_id: string, listener: (payload: unknown) => void) => {
    listeners.add(listener); return () => listeners.delete(listener);
  },
  onEmbeddedTerminalExit: (listener: (payload: unknown) => void) => {
    exitListeners.add(listener); return () => exitListeners.delete(listener);
  },
  resizeEmbeddedTerminal: async () => session,
  ackEmbeddedTerminalData: () => {},
  getDroppedFilePaths: async () => ["C:\\my images\\example.png"],
};
const { CommandRoom } = await import("../../src/rooms/CommandRoom");
const styles = document.createElement("style");
styles.textContent = "#root { height: 100vh; } .commandRoom { height: 100%; } .terminalStage { min-height: 580px; }";
document.head.appendChild(styles);
function Harness() {
  const [sessions, setSessions] = useState([session]);
  (window as any).chatTest.setSession = (patch: object) => setSessions([{ ...session, ...patch }]);
  return <CommandRoom workspace={session.workspace} sessions={sessions as any} agentSessions={[]} busy={false} focused={false}
    layoutResetNonce={0} interfaceMode="chat" onFocusChange={() => {}} onLaunch={async () => {}} onClose={async () => {}}
    onBroadcastPrompt={async () => {}} onResumeSession={async () => {}} onRenameEmbeddedSession={() => {}}
    onRenameAgentSession={() => {}} onRefreshAgentSessions={async () => {}} emptyMark={null} />;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><React.Profiler id="chat" onRender={() => { state.commits++; }}><Harness /></React.Profiler></React.StrictMode>,
);
