import childProcess from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const runtimeDirectory = process.env.ATHENA_BACKEND_RUNTIME_DIR?.trim()
  || path.join(repositoryRoot, "client", "backend-runtime", "athena-backend");
const executable = path.join(
  runtimeDirectory,
  process.platform === "win32" ? "athena-backend.exe" : "athena-backend",
);

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate backend smoke-test port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port, child, stderr, childError) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (childError.value) {
      throw new Error(`Bundled backend failed to start: ${childError.value.message}`);
    }
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`Bundled backend exited before becoming healthy.\n${stderr.value}`);
    }
    const healthy = await new Promise((resolve) => {
      const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.setTimeout(500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bundled backend did not become healthy.\n${stderr.value}`);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      child.removeListener("exit", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 5_000);
    child.once("exit", finish);
    child.kill();
  });
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
}

function isolatedRuntimeEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (["PATH", "PYTHONHOME", "PYTHONPATH"].includes(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    CONTEXT_WORKSPACE_PYTHON: "",
    PYTHONPATH: "",
    PATH: runtimeDirectory,
  };
}

async function smokeMcpServer() {
  const stderr = { value: "" };
  const child = childProcess.spawn(executable, ["--mcp-server"], {
    cwd: repositoryRoot,
    env: isolatedRuntimeEnvironment(),
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-16_384);
  });

  try {
    const response = await new Promise((resolve, reject) => {
      let stdout = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(
        () => finish(new Error(`Bundled MCP server handshake timed out.\n${stderr.value}`)),
        10_000,
      );
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => {
        if (!settled) {
          finish(new Error(`Bundled MCP server exited before initialize: ${code ?? signal}.\n${stderr.value}`));
        }
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          finish(null, JSON.parse(stdout.slice(0, newline)));
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.end(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "athena-runtime-smoke", version: "1" },
        },
      })}\n`);
    });
    if (response?.id !== 1 || response?.result?.serverInfo?.name !== "context_workspace") {
      throw new Error(`Bundled MCP server returned an invalid initialize response: ${JSON.stringify(response)}`);
    }
    console.log("Bundled MCP server initialize handshake passed.");
  } finally {
    await stopChild(child);
  }
}

const port = await findFreePort();
const stderr = { value: "" };
const childError = { value: null };
const child = childProcess.spawn(
  executable,
  ["--host", "127.0.0.1", "--port", String(port), "--no-access-log"],
  {
    cwd: repositoryRoot,
    env: isolatedRuntimeEnvironment(),
    windowsHide: true,
  },
);
child.once("error", (error) => {
  childError.value = error;
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr.value = `${stderr.value}${chunk}`.slice(-16_384);
});

try {
  await waitForHealth(port, child, stderr, childError);
  console.log(`Bundled backend health check passed on port ${port}.`);
} finally {
  await stopChild(child);
}

await smokeMcpServer();
