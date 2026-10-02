import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Folder, FolderOpen, Home, X } from "lucide-react";
import { desktop, type DirectoryListing } from "../electron";

// Picks a folder on another machine: the native file dialog can only browse
// this one. Lists folder names through that machine's Athena (GET /fs/dirs).
export function RemoteFolderDialog({
  machineId,
  machineName,
  initialPath,
  onOpen,
  onCancel,
}: {
  machineId: string;
  machineName: string;
  initialPath: string | null;
  onOpen: (path: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [pathDraft, setPathDraft] = useState(initialPath ?? "");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const browse = useCallback(async (target: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const next = await desktop.listRemoteDirectories(machineId, target);
      setListing(next);
      setPathDraft(next.path);
      listRef.current?.scrollTo({ top: 0 });
    } catch (caught) {
      setError(cleanError(caught));
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    void browse(initialPath);
  }, [browse, initialPath]);

  // Long paths: keep the folder you are in (the end) in view, not the root.
  useEffect(() => {
    const input = inputRef.current;
    if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
  }, [listing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  function jump(event: FormEvent) {
    event.preventDefault();
    if (pathDraft.trim()) void browse(pathDraft.trim());
  }

  async function open() {
    if (!listing) return;
    setOpening(true);
    setError(null);
    try {
      await onOpen(listing.path);
    } catch (caught) {
      setError(cleanError(caught));
      setOpening(false);
    }
  }

  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialogPanel remoteFolderDialog" role="dialog" aria-modal="true" aria-labelledby="remoteFolderTitle">
        <button className="dialogClose" type="button" aria-label="Close" onClick={onCancel}><X size={15} /></button>
        <strong id="remoteFolderTitle">Open a folder on {machineName}</strong>
        <form className="remoteFolderPath" onSubmit={jump}>
          <button
            type="button"
            className="iconButton"
            title="Up one folder"
            aria-label="Up one folder"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void browse(listing.parent)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="iconButton"
            title="Home folder"
            aria-label="Home folder"
            disabled={loading}
            onClick={() => void browse(listing?.home ?? null)}
          >
            <Home size={14} />
          </button>
          <input
            ref={inputRef}
            className="textInput"
            value={pathDraft}
            aria-label={`Folder path on ${machineName}`}
            spellCheck={false}
            onChange={(event) => setPathDraft(event.target.value)}
          />
          <button className="ghostButton small" type="submit" disabled={loading || !pathDraft.trim()}>Go</button>
        </form>
        <ul className="remoteFolderList" ref={listRef} aria-busy={loading} aria-label="Folders">
          {listing?.dirs.map((dir) => (
            <li key={dir.path}>
              <button type="button" onClick={() => void browse(dir.path)} onDoubleClick={() => void browse(dir.path)} title={dir.path}>
                <Folder size={14} aria-hidden="true" />
                <span>{dir.name}</span>
              </button>
            </li>
          ))}
          {listing && listing.dirs.length === 0 && !loading && <li className="remoteFolderEmpty">No folders here.</li>}
          {listing?.truncated && <li className="remoteFolderEmpty">Showing the first {listing.dirs.length} folders. Type a path to go further.</li>}
        </ul>
        {error && <p className="dialogWarning" role="alert">{error}</p>}
        <div className="dialogActions">
          <span className="remoteFolderHint">Agents you launch here run on {machineName}, in its copy of this folder.</span>
          <div>
            <button className="ghostButton" type="button" onClick={onCancel}>Cancel</button>
            <button className="primaryButton" type="button" disabled={!listing || loading || opening} onClick={() => void open()}>
              <FolderOpen size={14} /> {opening ? "Opening…" : "Open this folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "").replace(/^Error: /, "");
}
