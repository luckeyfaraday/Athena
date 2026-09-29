import { useEffect } from "react";
import { Copy, Download, ExternalLink, RefreshCw, X } from "lucide-react";
import type { AgentCliStatus } from "../electron";

// Asked when the user starts an agent whose CLI is not on PATH: install it machine-wide (in a visible pane), then launch.
export function AgentInstallDialog({
  status,
  action,
  onInstall,
  onRecheck,
  onCancel,
  onCopy,
  onOpenDocs,
}: {
  status: AgentCliStatus;
  // what happens after the install: "launch" a new pane or "resume" a session
  action: "launch" | "resume";
  onInstall: () => void;
  onRecheck: () => void;
  onCancel: () => void;
  onCopy: (text: string) => void;
  onOpenDocs: (url: string) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const npmMissing = status.needsNpm && !status.npmAvailable;
  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialogPanel" role="dialog" aria-modal="true" aria-labelledby="agentInstallTitle">
        <button className="dialogClose" type="button" aria-label="Cancel" onClick={onCancel}><X size={14} /></button>
        <strong id="agentInstallTitle">{status.label} isn't installed</strong>
        <p>
          Athena uses your machine-wide install and found no <code>{status.executable}</code> command on PATH.
          Install it now? It will then work in every terminal, not only in Athena.
        </p>
        {npmMissing ? (
          <p className="dialogWarning">
            This install needs npm, which comes with Node.js, and npm is not on PATH. Install Node.js LTS first
            (from nodejs.org, or on Windows: <code>winget install OpenJS.NodeJS.LTS</code>), then check again.
          </p>
        ) : null}
        <span className="dialogLabel">Athena will run this in a new terminal:</span>
        <pre>{status.installCommand}</pre>
        <div className="dialogActions">
          {status.docsUrl ? (
            <button className="linkButton" type="button" onClick={() => onOpenDocs(status.docsUrl)}>
              <ExternalLink size={13} /> Docs
            </button>
          ) : <span />}
          <div>
            <button className="ghostButton" type="button" onClick={() => onCopy(status.installCommand)}>
              <Copy size={14} /> Copy command
            </button>
            <button className="ghostButton" type="button" onClick={onCancel}>Cancel</button>
            {npmMissing ? (
              <button className="primaryButton" type="button" onClick={onRecheck}>
                <RefreshCw size={14} /> Check again
              </button>
            ) : (
              <button className="primaryButton" type="button" onClick={onInstall} autoFocus>
                <Download size={14} /> Install and {action === "resume" ? "resume" : "launch"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
