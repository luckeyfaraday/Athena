import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_SERVER_NAME,
  buildClaudeMcpConfig,
  buildCodexMcpConfigArgs,
  buildOpenCodeMcpConfigContent,
  bundledMcpServerCommand,
} from "../dist-electron/agent-mcp.js";

const SERVER = { command: "/opt/app/athena-backend", args: ["--mcp-server"] };
const BACKEND = "http://127.0.0.1:8123";
const CONTROL = "http://127.0.0.1:8124";

test("packaged MCP wiring resolves the bundled runtime on every desktop platform", () => {
  assert.deepEqual(
    bundledMcpServerCommand("/opt/ATHENA/resources/app.asar", "linux"),
    { command: "/opt/ATHENA/resources/backend-runtime/athena-backend/athena-backend", args: ["--mcp-server"] },
  );
  assert.deepEqual(
    bundledMcpServerCommand("C:\\Program Files\\ATHENA\\resources\\app.asar", "win32"),
    {
      command: "C:\\Program Files\\ATHENA\\resources\\backend-runtime\\athena-backend\\athena-backend.exe",
      args: ["--mcp-server"],
    },
  );
  assert.equal(bundledMcpServerCommand("/workspace/client", "linux"), null);
});

test("buildClaudeMcpConfig wires the stdio server and backend/control env", () => {
  const config = buildClaudeMcpConfig(SERVER, BACKEND, CONTROL);
  const entry = config.mcpServers[MCP_SERVER_NAME];
  assert.deepEqual(entry, {
    command: SERVER.command,
    args: SERVER.args,
    env: {
      CONTEXT_WORKSPACE_BACKEND_URL: BACKEND,
      CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: CONTROL,
    },
  });
});

test("buildCodexMcpConfigArgs emits TOML-encoded -c override values", () => {
  const args = buildCodexMcpConfigArgs(SERVER, BACKEND, CONTROL);
  assert.deepEqual(args, [
    `mcp_servers.${MCP_SERVER_NAME}.command="${SERVER.command}"`,
    `mcp_servers.${MCP_SERVER_NAME}.args=["--mcp-server"]`,
    `mcp_servers.${MCP_SERVER_NAME}.env={CONTEXT_WORKSPACE_BACKEND_URL="${BACKEND}",CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL="${CONTROL}"}`,
  ]);
});

test("buildCodexMcpConfigArgs TOML-escapes Windows command paths and arguments", () => {
  const [commandToken, argsToken] = buildCodexMcpConfigArgs(
    { command: "C:\\app\\athena-backend.exe", args: ["--mcp-server", "C:\\app\\server.py"] },
    BACKEND,
    CONTROL,
  );
  // JSON/TOML basic strings escape backslashes, so the path round-trips safely.
  assert.equal(commandToken, `mcp_servers.${MCP_SERVER_NAME}.command="C:\\\\app\\\\athena-backend.exe"`);
  assert.equal(argsToken, `mcp_servers.${MCP_SERVER_NAME}.args=["--mcp-server","C:\\\\app\\\\server.py"]`);
});

test("buildOpenCodeMcpConfigContent is a mergeable JSON mcp block only", () => {
  const parsed = JSON.parse(buildOpenCodeMcpConfigContent(SERVER, BACKEND, CONTROL));
  // Only the `mcp` key is present so opencode/athena keep the user's other config.
  assert.deepEqual(Object.keys(parsed), ["mcp"]);
  assert.deepEqual(parsed.mcp[MCP_SERVER_NAME], {
    type: "local",
    command: [SERVER.command, ...SERVER.args],
    enabled: true,
    environment: {
      CONTEXT_WORKSPACE_BACKEND_URL: BACKEND,
      CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: CONTROL,
    },
  });
});
