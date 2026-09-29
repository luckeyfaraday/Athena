import type { ReactNode } from "react";
import type { AdapterStatus, BackendStatus, ElectronControlStatus, HermesStatus } from "../api";

export type StatusTone = "ok" | "warn" | "bad";

export type StatusView = {
  label: string;
  tone: StatusTone;
};

export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`statusPill ${tone}`}>
      <span />
      {children}
    </span>
  );
}

export function backendStatusView(backend: BackendStatus | null): StatusView {
  if (backend?.healthy) return { tone: "ok", label: "Healthy" };
  if (backend?.running) return { tone: "warn", label: "Starting" };
  return { tone: "bad", label: "Offline" };
}

export function electronControlStatusView(control: ElectronControlStatus | null): StatusView {
  if (control?.running) return { tone: "ok", label: "Healthy" };
  if (control?.baseUrl) return { tone: "bad", label: "Stale" };
  return { tone: "bad", label: "Offline" };
}

export function hermesStatusView(hermes: HermesStatus | null): StatusView {
  if (hermes?.installed) {
    const versionLine = hermes.version?.split(/\r?\n/, 1)[0]?.trim();
    return { tone: "ok", label: versionLine || "Installed" };
  }
  return { tone: "bad", label: "Missing" };
}

export function adapterInstallStatusView(adapters: AdapterStatus[]): StatusView {
  const installed = adapters.filter((adapter) => adapter.installed).length;
  return {
    tone: installed > 0 ? "ok" : "warn",
    label: `${installed}/${adapters.length || 0} installed`,
  };
}
