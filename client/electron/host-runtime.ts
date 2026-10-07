import os from "node:os";
import path from "node:path";

/** The engine's small boundary with its host. Node services need no Electron. */
type HostRuntime = {
  version: () => string;
  userData: () => string;
  stateDirectory: () => string;
  broadcast: (channel: string, payload: unknown) => void;
};

let runtime: HostRuntime = {
  version: () => "unknown",
  userData: () => path.join(os.homedir(), ".context-workspace"),
  stateDirectory: () => path.join(os.homedir(), ".context-workspace"),
  broadcast: () => undefined,
};

export function configureHostRuntime(options: Partial<HostRuntime>): void {
  runtime = { ...runtime, ...options };
}

export const hostVersion = (): string => runtime.version();
export const hostUserData = (): string => runtime.userData();
export const hostStatePath = (name: string): string => path.join(runtime.stateDirectory(), name);
export const broadcastHostEvent = (channel: string, payload: unknown): void => runtime.broadcast(channel, payload);

/** Structural interface implemented by Electron WebContents; no runtime import. */
export type TerminalRenderer = {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
};
