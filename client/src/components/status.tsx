import type { ReactNode } from "react";

export function StatusPill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <span className={`statusPill ${tone}`}>
      <span />
      {children}
    </span>
  );
}

export function StatusDot({ status }: { status: "ready" | "running" | "waiting" | "offline" }) {
  return <span className={`statusDot ${status}`} />;
}
