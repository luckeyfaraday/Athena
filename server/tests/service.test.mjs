import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RemoteClient } from "../dist/remote-client.js";

const entry = fileURLToPath(new URL("../dist/server-main.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(30); }
  assert.fail(`Timed out: ${label}`);
}

async function start(dataDir, extra = [], { backend = false, env = {} } = {}) {
  const child = spawn(process.execPath, [entry, "run", "--local-only", ...backend ? [] : ["--no-backend"], "--data-dir", dataDir, ...extra], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  try {
    await until(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.includes("Athena server ready.");
    }, "service ready", 35_000);
  } catch (error) { child.kill(); throw error; }
  const discovery = JSON.parse(await fs.readFile(path.join(dataDir, "electron-control.json"), "utf8"));
  return { child, discovery, output: () => output, stop: async () => { child.kill(); await exited; } };
}

function viewer(discovery, label) {
  return new RemoteClient({
    discover: async () => ({ tailscale: "running", account: null, port: 47821, refreshedAt: null, machines: [{
      id: "server", name: "linux", url: discovery.baseUrl, status: "ready", online: true,
      address: "127.0.0.1", os: "linux", ownDevice: false, homedir: os.homedir(),
    }] }),
    tokenFor: () => discovery.token, broadcast: () => {}, selfName: () => label,
  });
}

test("real service keeps terminals alive across desktop disconnects and persists workspaces", { timeout: 90_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-server-test-"));
  const data = path.join(root, "state");
  const project = path.join(root, "project with spaces");
  await fs.mkdir(project);
  let host = await start(data, ["--workspace", project]);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.dispose();
    await host.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.doesNotMatch(host.output(), /athena_remote_/);
  const config = JSON.parse(await fs.readFile(path.join(data, "remote-access.json"), "utf8"));
  assert.match(config.token, /^athena_remote_/);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(data, "electron-control.json"))).mode & 0o777, 0o600);
  const unauthorized = await fetch(`${host.discovery.baseUrl}/terminals`);
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await fetch(`${host.discovery.baseUrl}/terminals`, {
    headers: { authorization: `Bearer ${host.discovery.token}`, origin: "https://untrusted.example" },
  });
  assert.equal(crossOrigin.status, 403);

  const first = viewer(host.discovery, "laptop"); clients.push(first);
  await first.refresh();
  await until(() => first.snapshot().machines[0]?.connection === "connected", "first viewer");
  assert.equal(first.snapshot().machines[0].workspaces[0].nativePath, project);
  const [session] = await first.spawn("server", { workspace: project, kind: "shell" });
  assert.equal(session.status, "running");
  assert.ok(session.pid > 0);
  const screen = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, send: () => {} });
  await first.attach(session.id, screen);
  const command = process.platform === "win32"
    ? "Start-Sleep -Milliseconds 600; Write-Output ('ATHENA_' + 'AFTER_DISCONNECT')\r"
    : "sleep 0.6; printf '\\nATHENA_%s\\n' AFTER_DISCONNECT\r";
  await first.write(session.id, command);
  first.dispose();
  await sleep(1_000);
  process.kill(session.pid, 0);

  const second = viewer(host.discovery, "other-computer"); clients.push(second);
  await second.refresh();
  await until(() => second.snapshot().machines[0]?.connection === "connected", "second viewer");
  const reconnected = second.snapshot().machines[0].sessions.find((item) => item.id === session.id);
  assert.equal(reconnected.pid, session.pid, "reconnect attaches to the original process");
  await until(async () => (await second.buffer(session.id)).includes("ATHENA_AFTER_DISCONNECT"), "output produced without clients");
  assert.deepEqual(await second.chatMessages(session.id), { messages: [], revision: "", missing: true });
  const renamed = await second.rename(session.id, "Persistent job");
  assert.equal(renamed.title, "Persistent job");
  await second.resize(session.id, 100, 30);
  const another = path.join(root, "another"); await fs.mkdir(another);
  await second.openWorkspace("server", another);
  await until(() => second.snapshot().machines[0].workspaces.length === 2, "host owns workspace events");
  await second.closeWorkspace("server", another);
  await until(() => second.snapshot().machines[0].workspaces.length === 1, "workspace closes");

  const duplicate = spawn(process.execPath, [entry, "run", "--data-dir", data, "--local-only", "--no-backend"], { stdio: "ignore", windowsHide: true });
  assert.equal((await once(duplicate, "exit"))[0], 1, "second service cannot take ownership");
  second.dispose();
  await host.stop();
  host = await start(data);
  const third = viewer(host.discovery, "after-restart"); clients.push(third);
  await third.refresh();
  await until(() => third.snapshot().machines[0]?.connection === "connected", "restart viewer");
  assert.deepEqual(third.snapshot().machines[0].workspaces.map((item) => item.nativePath), [project]);
  assert.equal(third.snapshot().machines[0].sessions.length, 0, "restart does not silently relaunch agents without --restore");
  assert.equal(JSON.parse(await fs.readFile(path.join(data, "remote-access.json"), "utf8")).token, config.token, "pairing survives restarts");
});

test("Linux service launches the Python backend and reads a native conversation through the remote API", {
  timeout: 90_000, skip: process.platform !== "linux" || process.env.ATHENA_TEST_BACKEND !== "1",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "athena-backend-test-"));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  await fs.mkdir(bin); await fs.mkdir(project);
  // Fixture executable only: this test never calls a paid model or reads real credentials.
  await fs.writeFile(path.join(root, ".bash_profile"), `export PATH='${bin}:${path.dirname(process.execPath)}':$PATH\n`);
  await fs.writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Claude fixture'); process.exit(0); }
const mcpConfig = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
fs.writeFileSync(path.join(process.env.HOME, 'launched-mcp.json'), JSON.stringify(mcpConfig.mcpServers.context_workspace));
const id = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
const folder = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(folder, { recursive: true });
const discovery = JSON.parse(fs.readFileSync(process.env.CONTEXT_WORKSPACE_ELECTRON_CONTROL_STATE, 'utf8'));
fetch(discovery.baseUrl + '/terminals', {headers:{authorization:'Bearer '+discovery.token}}).then(async response => {
  if (!response.ok) process.exit(2);
  const row = {uuid:'native-reply', sessionId:id, cwd:process.cwd(), timestamp:new Date().toISOString(), message:{role:'assistant',content:'Native reply from the server backend.'}};
  fs.writeFileSync(path.join(folder,id+'.jsonl'),JSON.stringify(row)+'\\n');
  console.log('FIXTURE_READY');
});
process.stdin.resume();
`, { mode: 0o700 });
  let host;
  let remote;
  t.after(async () => { remote?.dispose(); await host?.stop(); await fs.rm(root, { recursive: true, force: true }); });
  host = await start(path.join(root, "state"), ["--workspace", project], {
    backend: true, env: { HOME: root, PATH: `${bin}:${process.env.PATH}`, NVM_DIR: path.join(root, ".nvm") },
  });
  remote = viewer(host.discovery, "backend-viewer");
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "backend viewer");
  const [session] = await remote.spawn("server", { kind: "claude", workspace: project });
  assert.ok(session.providerSessionId);
  await until(async () => (await remote.buffer(session.id)).includes("FIXTURE_READY"), "fixture with inherited MCP discovery");
  const snapshot = await remote.chatMessages(session.id);
  assert.equal(snapshot.messages[0].text, "Native reply from the server backend.");
  const history = await remote.listAgentSessions("server", project);
  assert.ok(history.sessions.some((row) => row.id === session.providerSessionId));
  // Use the actual generated configuration with no inherited Athena variables.
  // MCP clients such as Codex only forward explicitly allowed environment data.
  const mcpConfig = JSON.parse(await fs.readFile(path.join(root, "launched-mcp.json"), "utf8"));
  const bridge = spawn(mcpConfig.command, mcpConfig.args, {
    env: { HOME: root, PATH: process.env.PATH, ...mcpConfig.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => bridge.kill());
  let rpcOutput = "";
  let rpcError = "";
  bridge.stdout.on("data", (chunk) => { rpcOutput += chunk; });
  bridge.stderr.on("data", (chunk) => { rpcError += chunk; });
  const bridgeExit = once(bridge, "exit");
  bridge.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "context_workspace_list_live_terminals", arguments: { project_dir: project } } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  assert.equal((await bridgeExit)[0], 0, rpcError);
  const reply = rpcOutput.trim().split("\n").map((line) => JSON.parse(line)).find((item) => item.id === 2);
  assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
  assert.match(reply.result.content[0].text, new RegExp(session.providerSessionId));
  const backendDiscovery = JSON.parse(await fs.readFile(path.join(root, "state", "backend.json"), "utf8"));
  await host.stop();
  assert.throws(() => process.kill(backendDiscovery.pid, 0), /ESRCH/);
});
