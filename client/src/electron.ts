import type { BackendStatus } from "./api";

type WorkspaceApi = {
  getBackendState: () => Promise<BackendStatus>;
  checkBackendHealth: () => Promise<BackendStatus>;
  restartBackend: () => Promise<BackendStatus>;
  selectWorkspace: () => Promise<string | null>;
};

declare global {
  interface Window {
    contextWorkspace: WorkspaceApi;
  }
}

export const desktop = window.contextWorkspace;
