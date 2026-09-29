import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

export type ToastTone = "ok" | "warn";
type Toast = { id: number; message: string; tone: ToastTone };

const toastLifetimeMs = 2600;
const maxToasts = 3;

// Short-lived confirmations ("Session ID copied", "Theme: Dusk"). Errors keep
// using the persistent notice bar.
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((message: string, tone: ToastTone = "ok") => {
    const id = ++nextId.current;
    setToasts((current) => [...current.filter((toast) => toast.message !== message), { id, message, tone }].slice(-maxToasts));
    timers.current.set(id, window.setTimeout(() => dismiss(id), toastLifetimeMs));
  }, [dismiss]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
  }, []);

  return { toasts, show, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toastStack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`} onClick={() => onDismiss(toast.id)}>
          {toast.tone === "warn" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
