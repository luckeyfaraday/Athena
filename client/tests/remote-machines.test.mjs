import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { parseTailscaleStatus } from "../dist-electron/remote-access.js";
import {
  classifyProbe,
  discoverMachines,
  isDesktopNode,
  machineName,
  probeMachine,
  RemoteMachineDirectory,
} from "../dist-electron/remote-machines.js";

const ME = 2539845234848443;
const NOW = () => new Date("2026-10-02T12:00:00Z");

function peer(overrides) {
  return {
    ID: `n${overrides.HostName}`,
    UserID: ME,
    OS: "linux",
    Online: true,
    ...overrides,
  };
}

function status(peers, selfOverrides = {}) {
  return parseTailscaleStatus({
    BackendState: "Running",
    User: { [ME]: { ID: ME, LoginName: "alan@example.com" }, 777: { ID: 777, LoginName: "friend@example.com" } },
    Self: { ID: "nSELF", UserID: ME, HostName: "omarchy", DNSName: "omarchy.tail1234.ts.net.", OS: "linux", Online: true, TailscaleIPs: ["100.101.102.103"], ...selfOverrides },
    Peer: Object.fromEntries(peers.map((item, index) => [`nodekey:${index}`, item])),
  });
}

test("classifyProbe maps answers to machine states", () => {
  assert.deepEqual(classifyProbe({ kind: "ok", body: { version: "0.3.0", platform: "win32", homedir: "C:\\Users\\alan" } }), {
    status: "ready", detail: null, version: "0.3.0", platform: "win32", homedir: "C:\\Users\\alan",
  });
  assert.equal(classifyProbe({ kind: "http", status: 401, error: null }).status, "needs-token");
  assert.equal(classifyProbe({ kind: "http", status: 403, error: "Browser requests are not accepted" }).detail, "Browser requests are not accepted");
  assert.equal(classifyProbe({ kind: "http", status: 429, error: null }).status, "refused");
  assert.equal(classifyProbe({ kind: "http", status: 500, error: null }).status, "unknown");
  assert.equal(classifyProbe({ kind: "unreachable", code: "ECONNREFUSED" }).status, "no-athena");
  assert.match(classifyProbe({ kind: "unreachable", code: "ETIMEDOUT" }).detail, /firewall/);
});

test("isDesktopNode and machineName", () => {
  assert.equal(isDesktopNode({ os: "windows" }), true);
  assert.equal(isDesktopNode({ os: "macOS" }), true);
  assert.equal(isDesktopNode({ os: "iOS" }), false);
  assert.equal(isDesktopNode({ os: "android" }), false);
  assert.equal(isDesktopNode({ os: null }), false);
  assert.equal(machineName({ dnsName: "laptop-nrstvp85-1.tail1234.ts.net", hostName: "LAPTOP-NRSTVP85", addresses: [] }), "laptop-nrstvp85-1");
  assert.equal(machineName({ dnsName: null, hostName: "box", addresses: [] }), "box");
});

test("discoverMachines probes online desktops, skips phones and offline devices, and sorts by readiness", async () => {
  const probed = [];
  const state = await discoverMachines({
    status: status([
      peer({ HostName: "surface", DNSName: "surface.tail1234.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::5", "100.124.147.99"] }),
      peer({ HostName: "win-pc", DNSName: "win-pc.tail1234.ts.net.", OS: "windows", TailscaleIPs: ["100.119.94.52"] }),
      peer({ HostName: "old-book", DNSName: "old-book.tail1234.ts.net.", Online: false, TailscaleIPs: ["100.78.74.36"] }),
      peer({ HostName: "phone", DNSName: "iphone.tail1234.ts.net.", OS: "iOS", TailscaleIPs: ["100.76.253.93"] }),
      peer({ HostName: "friend", DNSName: "friend.tail1234.ts.net.", UserID: 777, TailscaleIPs: ["100.80.0.1"] }),
      peer({ HostName: "ci", DNSName: "ci.tail1234.ts.net.", Tags: ["tag:ci"], TailscaleIPs: ["100.81.0.1"] }),
    ]),
    port: 47821,
    now: NOW,
    tokenFor: (id) => id === "nfriend" ? "athena_remote_friend" : null,
    probe: async (url, token) => {
      probed.push({ url, token });
      if (url.includes("100.124.147.99")) return { kind: "ok", body: { version: "0.3.1" } };
      if (url.includes("100.80.0.1")) return { kind: "http", status: 401, error: null };
      return { kind: "unreachable", code: "ECONNREFUSED" };
    },
  });
  assert.equal(state.tailscale, "running");
  assert.equal(state.account, "alan@example.com");
  assert.deepEqual(state.machines.map((machine) => [machine.name, machine.status]), [
    ["surface", "ready"],
    ["friend", "needs-token"],
    ["ci", "no-athena"],
    ["win-pc", "no-athena"],
    ["old-book", "offline"],
  ]);
  // IPv4 preferred for the URL; offline and phone peers never probed; tokens passed per machine.
  assert.deepEqual(probed.map((item) => item.url).sort(), [
    "http://100.119.94.52:47821",
    "http://100.124.147.99:47821",
    "http://100.80.0.1:47821",
    "http://100.81.0.1:47821",
  ]);
  assert.equal(probed.find((item) => item.url.includes("100.80.0.1")).token, "athena_remote_friend");
  const surface = state.machines[0];
  assert.equal(surface.ownDevice, true);
  assert.equal(surface.version, "0.3.1");
  assert.equal(surface.checkedAt, "2026-10-02T12:00:00.000Z");
  const byName = Object.fromEntries(state.machines.map((machine) => [machine.name, machine]));
  assert.equal(byName.friend.ownDevice, false);
  assert.equal(byName.friend.owner, "friend@example.com");
  assert.equal(byName.friend.detail, "Not on your Tailscale account, so it needs its access token.");
  assert.equal(byName.ci.ownDevice, false, "tagged devices are never your own");
  assert.equal(byName["old-book"].checkedAt, null);
});

test("discoverMachines explains a token request from one of your own machines", async () => {
  const state = await discoverMachines({
    status: status([peer({ HostName: "surface", DNSName: "surface.tail1234.ts.net.", TailscaleIPs: ["100.124.147.99"] })]),
    port: 47821,
    now: NOW,
    probe: async () => ({ kind: "http", status: 401, error: "Missing or invalid remote access token." }),
  });
  assert.equal(state.machines[0].status, "needs-token");
  assert.equal(state.machines[0].ownDevice, true);
  assert.match(state.machines[0].detail, /Trust my own devices/);
});

test("discoverMachines reports a missing or stopped Tailscale", async () => {
  const missing = await discoverMachines({ status: null, port: 47821, now: NOW, probe: async () => assert.fail("no probe") });
  assert.equal(missing.tailscale, "unavailable");
  assert.deepEqual(missing.machines, []);
  const stopped = await discoverMachines({
    status: parseTailscaleStatus({ BackendState: "Stopped" }),
    port: 47821,
    now: NOW,
    probe: async () => assert.fail("no probe"),
  });
  assert.equal(stopped.tailscale, "stopped");
});

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("probeMachine reads /machine with an optional bearer token", async () => {
  await withServer((request, response) => {
    if (request.url !== "/machine") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization === "Bearer good") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "0.3.1", hostname: "surface" }));
      return;
    }
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Missing or invalid remote access token." }));
  }, async (url) => {
    assert.deepEqual(await probeMachine(url, "good"), { kind: "ok", body: { version: "0.3.1", hostname: "surface" } });
    assert.deepEqual(await probeMachine(url, null), { kind: "http", status: 401, error: "Missing or invalid remote access token." });
  });
});

test("probeMachine reports a closed port as unreachable", async () => {
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const result = await probeMachine(`http://127.0.0.1:${port}`, null);
  assert.deepEqual(result, { kind: "unreachable", code: "ECONNREFUSED" });
});

test("RemoteMachineDirectory shares refreshes and serves cached state while refreshing in the background", async () => {
  let loads = 0;
  let refreshedAt = new Date().toISOString();
  const directory = new RemoteMachineDirectory(async (fresh) => {
    loads += 1;
    return { tailscale: "running", account: null, port: 47821, machines: [], refreshedAt, fresh };
  });
  assert.equal(directory.state, null);
  const [first, second] = await Promise.all([directory.refresh(), directory.refresh()]);
  assert.equal(loads, 1, "concurrent refreshes share one load");
  assert.equal(first, second);
  assert.equal((await directory.get(60_000)).refreshedAt, refreshedAt);
  assert.equal(loads, 1, "fresh enough: no reload");
  refreshedAt = new Date(Date.now() - 120_000).toISOString();
  await directory.refresh();
  assert.equal(loads, 2);
  const stale = await directory.get(60_000);
  assert.equal(stale.refreshedAt, refreshedAt, "stale state is served immediately");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 3, "and refreshed in the background");
});
