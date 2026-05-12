export type BackendStatus = {
  baseUrl: string | null;
  healthy: boolean;
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

export type RecallStatus = {
  project_dir: string;
  exists: boolean;
  status: "missing" | "stale" | "fresh";
  stale: boolean;
  path: string;
  metadata_path: string;
  bytes: number;
  refreshed_at: string | null;
  age_seconds: number | null;
  stale_after_seconds: number;
  source: string | null;
  refresh_configured: boolean;
};

export type RecallRefreshResult = {
  refresh: {
    configured: boolean;
    returncode: number;
    stdout: string;
    stderr: string;
  };
  recall: RecallStatus;
};

export type AdapterStatus = {
  agent_type: string;
  configured: boolean;
  executable: string;
  installed: boolean;
  command_path: string | null;
};

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type Run = {
  run_id: string;
  agent_id: string;
  agent_type: string;
  project_dir: string;
  task: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
};

export type RunArtifact = {
  name: string;
  exists: boolean;
  size_bytes: number;
  url: string;
};

export type RunDetail = {
  run: Run;
  artifacts: Record<string, RunArtifact>;
};

export class BackendClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<{ status: string }> {
    return this.json("/health");
  }

  async hermesStatus(): Promise<HermesStatus> {
    const response = await this.json<{ hermes: HermesStatus }>("/hermes/status");
    return response.hermes;
  }

  async recallStatus(projectDir: string): Promise<RecallStatus> {
    const response = await this.json<{ recall: RecallStatus }>(`/hermes/recall/status?project_dir=${encodeURIComponent(projectDir)}`);
    return response.recall;
  }

  async refreshRecall(projectDir: string, taskHint?: string): Promise<RecallRefreshResult> {
    return this.json("/hermes/recall/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_dir: projectDir,
        task_hint: taskHint,
      }),
    });
  }

  async adapters(): Promise<Record<string, AdapterStatus>> {
    const response = await this.json<{ adapters: Record<string, AdapterStatus> }>("/agents/adapters");
    return response.adapters;
  }

  async runs(): Promise<Run[]> {
    const response = await this.json<{ runs: Run[] }>("/agents/runs");
    return response.runs;
  }

  async run(runId: string): Promise<RunDetail> {
    return this.json(`/agents/runs/${encodeURIComponent(runId)}`);
  }

  async artifact(runId: string, artifactName: string, maxBytes = 65536): Promise<string> {
    return this.text(`/agents/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}?max_bytes=${maxBytes}`);
  }

  async agentSessionTranscript(provider: string, sessionId: string, maxBytes = 262144): Promise<string> {
    return this.text(
      `/agents/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/transcript?max_bytes=${maxBytes}`,
    );
  }

  async recentMemory(limit = 20): Promise<string[]> {
    const response = await this.json<{ entries: string[] }>(`/memory/recent?limit=${limit}`);
    return response.entries;
  }

  async projectMemory(projectDir: string, limit = 20): Promise<string[]> {
    const params = new URLSearchParams({ project_dir: projectDir, limit: String(limit) });
    const response = await this.text(`/memory/hermes/project?${params.toString()}`);
    return response
      .replace(/^Project context from Hermes memory:\s*/i, "")
      .split(/\n\n-\s+/)
      .map((entry) => entry.replace(/^-\s+/, "").trim())
      .filter(Boolean);
  }

  async deleteMemory(text: string): Promise<{ deleted: boolean; removed: number }> {
    return this.json("/memory/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  async spawnCodex(projectDir: string, task: string): Promise<Run> {
    const response = await this.json<{ run: Run }>("/agents/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_type: "codex",
        project_dir: projectDir,
        task,
      }),
    });
    return response.run;
  }

  async cancelRun(runId: string): Promise<Run> {
    const response = await this.json<{ run: Run }>(`/agents/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
    return response.run;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.json() as Promise<T>;
  }

  private async text(path: string, init?: RequestInit): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.text();
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
