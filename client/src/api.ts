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

export class BackendClient {
  constructor(private readonly baseUrl: string) {}

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
