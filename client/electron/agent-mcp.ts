// MCP wiring for embedded agents.
//
// Each agent CLI registers the Context Workspace MCP server through a different
// mechanism, so this module owns the per-agent config generation and keeps it
// free of PTY/filesystem state for unit testing:
//   - Claude  -> a JSON file passed via `--mcp-config <file>`.
//   - Codex   -> `-c <dotted.key=toml-value>` overrides (no config-file flag).
//   - opencode / athena-code -> the `OPENCODE_CONFIG_CONTENT` env var, which is
//     deep-merged over the user's config so their providers/auth stay intact.
//
// All three point at the same stdio server command and pass the backend/control
// URLs through the environment the server reads on startup.

import path from "node:path";

export const MCP_SERVER_NAME = "context_workspace";

// Launch-time MCP data threaded into terminal-launch's command assembly. Only
// the field for the agent being launched is populated; opencode/athena carry no
// launch data because they are wired through the environment instead.
export type AgentMcpLaunch = {
  /** Claude reads its MCP servers from a JSON file passed via `--mcp-config`. */
  configPath?: string | null;
  /** Codex has no config-file flag, so its server is injected as `-c` overrides. */
  codexConfigArgs?: readonly string[] | null;
};

export type McpServerCommand = {
  command: string;
  args: string[];
};

export function bundledMcpServerCommand(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
): McpServerCommand | null {
  if (!appRoot.includes(".asar")) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "athena-backend.exe" : "athena-backend";
  return {
    command: pathApi.join(pathApi.dirname(appRoot), "backend-runtime", "athena-backend", executable),
    args: ["--mcp-server"],
  };
}

export type ClaudeMcpConfig = {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
};

function mcpServerEnv(backendUrl: string, controlUrl: string): Record<string, string> {
  return {
    CONTEXT_WORKSPACE_BACKEND_URL: backendUrl,
    CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: controlUrl,
  };
}

export function buildClaudeMcpConfig(server: McpServerCommand, backendUrl: string, controlUrl: string): ClaudeMcpConfig {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: server.command,
        args: server.args,
        env: mcpServerEnv(backendUrl, controlUrl),
      },
    },
  };
}

export function buildCodexMcpConfigArgs(server: McpServerCommand, backendUrl: string, controlUrl: string): string[] {
  // Codex parses the value after each `=` as TOML, falling back to a literal
  // string. Basic (double-quoted) TOML strings share JSON's escaping rules for
  // the paths and URLs used here, so JSON.stringify produces a valid TOML value.
  const toml = (value: string): string => JSON.stringify(value);
  const key = `mcp_servers.${MCP_SERVER_NAME}`;
  const env = mcpServerEnv(backendUrl, controlUrl);
  const envTable = Object.entries(env)
    .map(([name, value]) => `${name}=${toml(value)}`)
    .join(",");
  return [
    `${key}.command=${toml(server.command)}`,
    `${key}.args=[${server.args.map(toml).join(",")}]`,
    `${key}.env={${envTable}}`,
  ];
}

export function buildOpenCodeMcpConfigContent(server: McpServerCommand, backendUrl: string, controlUrl: string): string {
  // opencode (and the athena-code fork) deep-merge OPENCODE_CONFIG_CONTENT over
  // the resolved config, so injecting only the `mcp` block leaves the user's
  // providers, agents, and auth untouched.
  return JSON.stringify({
    mcp: {
      [MCP_SERVER_NAME]: {
        type: "local",
        command: [server.command, ...server.args],
        enabled: true,
        environment: mcpServerEnv(backendUrl, controlUrl),
      },
    },
  });
}
