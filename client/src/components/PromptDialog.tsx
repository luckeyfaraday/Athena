import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";

export type TextPromptRequest = {
  title: string;
  label?: string;
  initialValue: string;
  confirmLabel?: string;
  placeholder?: string;
};

// In-app replacement for window.prompt(), which Electron does not implement
// (it returns nothing, so every rename silently did nothing).
export function PromptDialog({
  request,
  onSubmit,
  onCancel,
}: {
  request: TextPromptRequest;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(request.initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <form className="dialogPanel narrow" role="dialog" aria-modal="true" aria-labelledby="promptDialogTitle" onSubmit={submit}>
        <button className="dialogClose" type="button" aria-label="Cancel" onClick={onCancel}><X size={15} /></button>
        <strong id="promptDialogTitle">{request.title}</strong>
        <label className="dialogField">
          {request.label ? <span className="dialogLabel">{request.label}</span> : null}
          <input
            ref={inputRef}
            className="textInput"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="dialogActions end">
          <div>
            <button className="ghostButton" type="button" onClick={onCancel}>Cancel</button>
            <button className="primaryButton" type="submit" disabled={!value.trim()}>{request.confirmLabel ?? "Save"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
