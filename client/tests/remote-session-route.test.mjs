import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Only Electron's window facade is replaced. Exercise the real HTTP router,
// authorization gate, worker-only call, cache, validation and response status.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,export const app = { getVersion: () => "test" }; export const BrowserWindow = { getAllWindows: () => [] };', shortCircuit: true };
    return next(specifier, context);
  }
`)}`);
const { createControlRequestListener } = await import("../dist-electron/control-server.js");
const { evaluateControlAccess } = await import("../dist-electron/control-access.js");
const { sessionIndexClient } = await import("../dist-electron/session-index-client.js");

test("remote history requires authorization and coalesces authorized requests through the worker", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "athena-remote-history-"));
  const original = sessionIndexClient.listAgentSessions;
  const scans = [];
  let resolveScan;
  sessionIndexClient.listAgentSessions = (folder, allowStale) => {
    scans.push({ folder, allowStale });
    return new Promise((resolve) => { resolveScan = resolve; });
  };
  const server = http.createServer(createControlRequestListener({
    source: "remote",
    authorize: (request) => evaluateControlAccess({ host: request.headers.host, authorization: request.headers.authorization }, "test-secret"),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    sessionIndexClient.listAgentSessions = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/agent-sessions?workspace=${encodeURIComponent(workspace)}`;
  const options = { headers: { authorization: "Bearer test-secret" } };
  assert.equal((await fetch(url)).status, 401);
  assert.equal(scans.length, 0);
  assert.equal((await fetch(`${base}/agent-sessions?workspace=relative`, options)).status, 400);
  assert.equal(scans.length, 0);
  const first = fetch(url, options);
  const second = fetch(url, options);
  for (let i = 0; i < 100 && !resolveScan; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scans.length, 1);
  assert.equal(scans[0].allowStale, false);
  assert.equal((await fetch(`${base}/terminals`, options)).status, 200, "terminal API answers during a cold history scan");
  resolveScan([]);
  assert.equal((await first).status, 200);
  assert.deepEqual(await (await second).json(), { sessions: [], nextCursor: null, warning: null });
  assert.equal(scans.length, 1);
  assert.equal((await fetch(`${url}&cursor=bad`, options)).status, 409);
});

test("a failed worker returns a temporary history error through the route", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "athena-remote-history-failure-"));
  const original = sessionIndexClient.listAgentSessions;
  sessionIndexClient.listAgentSessions = async () => null;
  const server = http.createServer(createControlRequestListener({ source: "remote", authorize: () => ({ ok: true }) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    sessionIndexClient.listAgentSessions = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/agent-sessions?workspace=${encodeURIComponent(workspace)}`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /temporarily unavailable/);
});
