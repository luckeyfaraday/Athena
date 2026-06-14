import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_SERVER_NAME,
  buildClaudeMcpConfig,
  buildCodexMcpConfigArgs,
  buildOpenCodeMcpConfigContent,
} from "../dist-electron/agent-mcp.js";

const SERVER = "/opt/app/mcp_server/server.py";
const BACKEND = "http://127.0.0.1:8123";
const CONTROL = "http://127.0.0.1:8124";

test("buildClaudeMcpConfig wires the stdio server and backend/control env", () => {
  const config = buildClaudeMcpConfig(SERVER, BACKEND, CONTROL);
  const entry = config.mcpServers[MCP_SERVER_NAME];
  assert.deepEqual(entry, {
    command: "python3",
    args: [SERVER],
    env: {
      CONTEXT_WORKSPACE_BACKEND_URL: BACKEND,
      CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: CONTROL,
    },
  });
});

test("buildCodexMcpConfigArgs emits TOML-encoded -c override values", () => {
  const args = buildCodexMcpConfigArgs(SERVER, BACKEND, CONTROL);
  assert.deepEqual(args, [
    `mcp_servers.${MCP_SERVER_NAME}.command="python3"`,
    `mcp_servers.${MCP_SERVER_NAME}.args=["${SERVER}"]`,
    `mcp_servers.${MCP_SERVER_NAME}.env={CONTEXT_WORKSPACE_BACKEND_URL="${BACKEND}",CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL="${CONTROL}"}`,
  ]);
});

test("buildCodexMcpConfigArgs TOML-escapes Windows backslashes in the server path", () => {
  const [, argsToken] = buildCodexMcpConfigArgs("C:\\app\\server.py", BACKEND, CONTROL);
  // JSON/TOML basic strings escape backslashes, so the path round-trips safely.
  assert.equal(argsToken, `mcp_servers.${MCP_SERVER_NAME}.args=["C:\\\\app\\\\server.py"]`);
});

test("buildOpenCodeMcpConfigContent is a mergeable JSON mcp block only", () => {
  const parsed = JSON.parse(buildOpenCodeMcpConfigContent(SERVER, BACKEND, CONTROL));
  // Only the `mcp` key is present so opencode/athena keep the user's other config.
  assert.deepEqual(Object.keys(parsed), ["mcp"]);
  assert.deepEqual(parsed.mcp[MCP_SERVER_NAME], {
    type: "local",
    command: ["python3", SERVER],
    enabled: true,
    environment: {
      CONTEXT_WORKSPACE_BACKEND_URL: BACKEND,
      CONTEXT_WORKSPACE_ELECTRON_CONTROL_URL: CONTROL,
    },
  });
});
