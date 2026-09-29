import type { UsageSnapshot } from "./usage-display";

export type BackendStatus = {
  baseUrl: string | null;
  healthy: boolean;
  running: boolean;
  port: number | null;
  lastError: string | null;
};

export type ElectronControlStatus = {
  baseUrl: string | null;
  running: boolean;
  port: number | null;
  lastError: string | null;
};

export type HermesStatus = {
  installed: boolean;
  command_path: string | null;
  version: string | null;
  hermes_home: string;
  config_exists: boolean;
  memory_path: string | null;
  native_windows: boolean;
  install_supported: boolean;
  setup_required: boolean;
  message: string;
};

export type HermesInstallResult = {
  returncode: number;
  stdout: string;
  stderr: string;
  hermes: HermesStatus;
};

export type AdapterStatus = {
  agent_type: string;
  configured: boolean;
  executable: string;
  installed: boolean;
  command_path: string | null;
};

export type NativeChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
};

/** `missing`: the session's file does not exist yet (a quiet state, not an error). */
export type NativeChatSnapshot = { messages: NativeChatMessage[]; revision: string; missing?: boolean };

export class BackendClient {
  constructor(private readonly baseUrl: string) {}

  async chatMessages(provider: string, sessionId: string, signal: AbortSignal, workspace?: string): Promise<NativeChatSnapshot> {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    return this.json(`/agents/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/chat${query}`, { signal });
  }

  async hermesStatus(): Promise<HermesStatus> {
    const response = await this.json<{ hermes: HermesStatus }>("/hermes/status");
    return response.hermes;
  }

  async installHermes(timeoutSeconds = 600): Promise<HermesInstallResult> {
    return this.json("/hermes/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, timeout_seconds: timeoutSeconds }),
    });
  }

  async adapters(): Promise<Record<string, AdapterStatus>> {
    const response = await this.json<{ adapters: Record<string, AdapterStatus> }>("/agents/adapters");
    return response.adapters;
  }

  /** Cached subscription usage; the backend refreshes providers in the background. */
  async usageAccounts(): Promise<UsageSnapshot> {
    // Bounded, so a hung backend surfaces as a failed poll instead of a frozen "live" reading.
    return this.json("/usage/accounts", { signal: AbortSignal.timeout(15_000) });
  }

  /** Ask the backend to re-read provider quotas now (bounded wait, deduplicated). */
  async refreshUsage(options: { provider?: string; accountKey?: string } = {}): Promise<UsageSnapshot> {
    return this.json("/usage/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: options.provider ?? null, account_key: options.accountKey ?? null }),
      // The backend waits up to 12 s for the probe itself.
      signal: AbortSignal.timeout(25_000),
    });
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.json() as Promise<T>;
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
