import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Monitor, Settings2 } from "lucide-react";
import type { SwitcherEntry } from "../remote-view";
import type { WorkspaceAttentionKind } from "../workspace-attention";

// Picks whose terminals the Command Room shows: this machine or another one on
// the tailnet. Lives at the start of the workspace tab strip.
export function MachineSwitcher({
  entries,
  activeMachineId,
  localName,
  localRunning,
  attentionByMachine,
  onSelect,
  onManage,
}: {
  entries: SwitcherEntry[];
  activeMachineId: string | null;
  localName: string;
  localRunning: number;
  attentionByMachine: Record<string, WorkspaceAttentionKind>;
  onSelect: (machineId: string | null) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active = activeMachineId ? entries.find((entry) => entry.id === activeMachineId) : null;
  const label = active?.name ?? localName;
  // Attention elsewhere: the badge on the closed switcher.
  const elsewhere = entries.some((entry) => entry.id !== activeMachineId && attentionByMachine[entry.id]);
  const elsewhereAction = entries.some((entry) => entry.id !== activeMachineId && attentionByMachine[entry.id] === "action");

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    const closeOnBlur = () => setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);

  function choose(machineId: string | null) {
    setOpen(false);
    onSelect(machineId);
  }

  return (
    <div className="machineSwitcher" ref={rootRef}>
      <button
        type="button"
        className={["machineSwitcherButton", activeMachineId ? "remote" : "", open ? "open" : ""].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeMachineId ? `Viewing ${label}. Switch machine` : "Switch to another machine's terminals"}
        onClick={() => setOpen((value) => !value)}
      >
        <Monitor size={14} aria-hidden="true" />
        <span className="machineSwitcherName">{label}</span>
        {elsewhere && <i className={elsewhereAction ? "machineAttentionDot action" : "machineAttentionDot"} aria-label="A machine needs attention" />}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="machineSwitcherMenu" role="menu" aria-label="Machines">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!activeMachineId}
            className={!activeMachineId ? "active" : ""}
            onClick={() => choose(null)}
          >
            <span className="machineSwitcherCheck">{!activeMachineId && <Check size={13} />}</span>
            <span className="machineSwitcherText">
              <strong>{localName}</strong>
              <small>This machine{localRunning ? ` · ${localRunning} running` : ""}</small>
            </span>
          </button>
          {entries.length > 0 && <div className="menuSeparator" role="separator" />}
          {entries.map((entry) => {
            const current = entry.id === activeMachineId;
            const attention = attentionByMachine[entry.id];
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                className={current ? "active" : ""}
                disabled={!entry.available && !current && entry.state !== "Needs token"}
                title={entry.state === "Needs token" ? "Add this machine's access token in Settings > System" : undefined}
                onClick={() => (entry.state === "Needs token" ? (setOpen(false), onManage()) : choose(entry.id))}
              >
                <span className="machineSwitcherCheck">{current && <Check size={13} />}</span>
                <span className="machineSwitcherText">
                  <strong>{entry.name}</strong>
                  <small>{entry.state}</small>
                </span>
                {attention && (
                  <em className={`workspaceAttentionBadge ${attention}`}>{attention === "action" ? "Needs input" : "Done"}</em>
                )}
              </button>
            );
          })}
          <div className="menuSeparator" role="separator" />
          <button type="button" role="menuitem" className="machineSwitcherManage" onClick={() => { setOpen(false); onManage(); }}>
            <Settings2 size={13} /> Remote access and machines…
          </button>
        </div>
      )}
    </div>
  );
}
