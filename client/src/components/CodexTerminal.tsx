import { ExternalLink, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { desktop, type NativeTerminalSession } from "../electron";

export function CodexTerminal({ workspace }: { workspace: string }) {
  const [sessions, setSessions] = useState<NativeTerminalSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSessions();
  }, []);

  async function refreshSessions() {
    const nextSessions = await desktop.getNativeTerminalSessions();
    setSessions(nextSessions);
  }

  async function launchNative() {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await desktop.openNativeCodexTerminal(workspace);
      if (!result.ok) {
        setError(result.error ?? "Unable to launch native terminal.");
      }
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function launchGrid() {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await desktop.openNativeCodexGrid(workspace, 4);
      if (!result.ok) {
        setError(result.error ?? "Unable to launch native terminal grid.");
      }
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel codexTerminalPanel nativeTerminalPanel">
      <div className="panelHeader">
        <div>
          <div className="panelTitle">
            <TerminalSquare size={16} />
            <h2>Native Terminals</h2>
          </div>
          <span className="panelMeta">Codex launches in your OS terminal with Hermes memory attached</span>
        </div>
        <div className="terminalActions">
          <button className="button buttonSecondary" onClick={launchGrid} disabled={!workspace || busy}>
            <TerminalSquare size={15} />
            Launch Grid
          </button>
          <button className="button buttonPrimary" onClick={launchNative} disabled={!workspace || busy}>
            <ExternalLink size={15} />
            Launch Single
          </button>
        </div>
      </div>
      {error && <div className="terminalStatus">{error}</div>}
      <div className="nativeTerminalBody">
        <div className="nativeTerminalHero">
          <TerminalSquare size={28} />
          <div>
            <strong>{workspace ? "Ready to launch native Codex" : "Select a workspace first"}</strong>
            <span>
              Launch one session, or launch a native grid of Codex panes. Grid mode uses tmux so panes stay organized in one terminal window.
            </span>
          </div>
        </div>
        <div className="sessionRows">
          {sessions.map((session) => (
            <article key={session.id} className="sessionRow">
              <div>
                <strong>{session.workspace}</strong>
                <span>{session.mode === "grid" ? `${session.panes} pane grid` : session.promptPath ?? "No memory prompt file"}</span>
              </div>
              <span className={session.status === "launched" ? "statusPill ok" : "statusPill bad"}>
                <span />
                {session.pid ? `pid ${session.pid}` : session.status}
              </span>
            </article>
          ))}
          {sessions.length === 0 && <p className="empty">No native terminal sessions launched yet.</p>}
        </div>
      </div>
    </section>
  );
}
