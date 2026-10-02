import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AuthFailureLimiter,
  DEFAULT_REMOTE_PORT,
  evaluateRemoteAccess,
  generateRemoteToken,
  isOwnDevice,
  isTailscaleAddress,
  normalizeAddress,
  normalizeRemotePort,
  parseTailscaleStatus,
  parseTailscaleWhois,
  readRemoteAccessConfig,
  remoteHostAllowed,
  remoteUrl,
  RemoteListenerSet,
  tailscaleAddresses,
  writeRemoteAccessConfig,
} from "../dist-electron/remote-access.js";

const TOKEN = generateRemoteToken();
const BOUND = ["100.101.102.103", "fd7a:115c:a1e0::1234"];
const PEER = "100.90.1.2";

function remoteRequest(overrides = {}) {
  return {
    remoteAddress: PEER,
    host: "100.101.102.103:47821",
    authorization: `Bearer ${TOKEN}`,
    ...overrides,
  };
}

test("isTailscaleAddress matches the tailnet CGNAT and ULA ranges only", () => {
  for (const address of ["100.64.0.1", "100.127.255.254", "100.101.102.103", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667"]) {
    assert.equal(isTailscaleAddress(address), true, address);
  }
  for (const address of ["100.63.255.255", "100.128.0.1", "10.0.0.5", "192.168.1.20", "127.0.0.1", "::1", "fd7a:115c:a1e1::1", "fe80::1", "", undefined, "not-an-ip"]) {
    assert.equal(isTailscaleAddress(address), false, String(address));
  }
});

test("normalizeAddress strips brackets, zones, and the IPv4-mapped prefix", () => {
  assert.equal(normalizeAddress("::ffff:100.64.1.2"), "100.64.1.2");
  assert.equal(normalizeAddress("[fd7a:115c:a1e0::1]"), "fd7a:115c:a1e0::1");
  assert.equal(normalizeAddress("fe80::1%tailscale0"), "fe80::1");
  assert.equal(normalizeAddress("FD7A:115C:A1E0::1"), "fd7a:115c:a1e0::1");
});

test("tailscaleAddresses picks tailnet addresses from any interface, IPv4 first", () => {
  const interfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
    tailscale0: [
      { address: "fd7a:115c:a1e0::1234", family: "IPv6", internal: false },
      { address: "100.101.102.103", family: "IPv4", internal: false },
    ],
    // Windows names the adapter "Tailscale".
    Tailscale: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  };
  assert.deepEqual(tailscaleAddresses(interfaces), ["100.101.102.103", "fd7a:115c:a1e0::1234"]);
  assert.deepEqual(tailscaleAddresses({ eth0: interfaces.eth0 }), []);
});

test("remoteUrl brackets IPv6 addresses", () => {
  assert.equal(remoteUrl("100.64.0.1", 47821), "http://100.64.0.1:47821");
  assert.equal(remoteUrl("fd7a:115c:a1e0::1", 47821), "http://[fd7a:115c:a1e0::1]:47821");
});

test("remoteHostAllowed accepts bound addresses and MagicDNS names", () => {
  for (const host of ["100.101.102.103:47821", "[fd7a:115c:a1e0::1234]:47821", "arch-desktop.tail1234.ts.net:47821", "arch-desktop:47821", "WIN-PC"]) {
    assert.equal(remoteHostAllowed(host, BOUND), true, host);
  }
});

test("remoteHostAllowed refuses rebinding domains, other IPs, and empty Host", () => {
  for (const host of ["evil.example.com:47821", "100.64.9.9:47821", "192.168.1.20:47821", "127.0.0.1:47821", "localhost.evil.com", "localhost:47821", "12345", "", undefined]) {
    assert.equal(remoteHostAllowed(host, BOUND), false, String(host));
  }
});

test("evaluateRemoteAccess accepts a tailnet peer with the token", () => {
  assert.deepEqual(evaluateRemoteAccess(remoteRequest(), { token: TOKEN, boundAddresses: BOUND }), { ok: true });
  const viaHeader = remoteRequest({ authorization: undefined, token: TOKEN, host: "arch-desktop.tail1234.ts.net" });
  assert.deepEqual(evaluateRemoteAccess(viaHeader, { token: TOKEN, boundAddresses: BOUND }), { ok: true });
});

test("evaluateRemoteAccess refuses peers outside the tailnet even with the token", () => {
  for (const remoteAddress of ["192.168.1.50", "127.0.0.1", "::1", undefined]) {
    const decision = evaluateRemoteAccess(remoteRequest({ remoteAddress }), { token: TOKEN, boundAddresses: BOUND });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 403);
  }
});

test("evaluateRemoteAccess refuses foreign Host headers (DNS rebinding)", () => {
  const decision = evaluateRemoteAccess(remoteRequest({ host: "evil.example.com:47821" }), { token: TOKEN, boundAddresses: BOUND });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
});

test("evaluateRemoteAccess refuses any browser Origin", () => {
  const decision = evaluateRemoteAccess(remoteRequest({ origin: "http://100.101.102.103:47821" }), { token: TOKEN, boundAddresses: BOUND });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
});

test("evaluateRemoteAccess requires the exact remote token", () => {
  const missing = evaluateRemoteAccess(remoteRequest({ authorization: undefined }), { token: TOKEN, boundAddresses: BOUND });
  assert.equal(missing.status, 401);
  const wrong = evaluateRemoteAccess(remoteRequest({ authorization: `Bearer ${generateRemoteToken()}` }), { token: TOKEN, boundAddresses: BOUND });
  assert.equal(wrong.status, 401);
  const uninitialized = evaluateRemoteAccess(remoteRequest(), { token: null, boundAddresses: BOUND });
  assert.equal(uninitialized.status, 503);
});

test("AuthFailureLimiter blocks a peer after repeated failures and forgets them after the window", () => {
  let now = 1_000_000;
  const limiter = new AuthFailureLimiter(3, 60_000, () => now);
  for (let index = 0; index < 3; index += 1) limiter.recordFailure(PEER);
  assert.equal(limiter.blocked(PEER), true);
  assert.equal(limiter.blocked("100.90.9.9"), false);
  now += 60_001;
  assert.equal(limiter.blocked(PEER), false);
  limiter.recordFailure(PEER);
  limiter.recordSuccess(PEER);
  assert.equal(limiter.blocked(PEER), false);
});

test("generateRemoteToken returns distinct, prefixed, high-entropy tokens", () => {
  const first = generateRemoteToken();
  const second = generateRemoteToken();
  assert.notEqual(first, second);
  assert.match(first, /^athena_remote_[A-Za-z0-9_-]{43}$/);
});

test("normalizeRemotePort accepts unprivileged ports only", () => {
  assert.equal(normalizeRemotePort("47821"), 47821);
  assert.equal(normalizeRemotePort(65535), 65535);
  for (const value of [80, 1023, 65536, 4782.1, "abc", null]) {
    assert.throws(() => normalizeRemotePort(value), /Remote access port/);
  }
});

test("remote access config round-trips with 0600 permissions and safe defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-remote-"));
  try {
    const file = path.join(dir, "nested", "remote-access.json");
    assert.deepEqual(readRemoteAccessConfig(file), { enabled: false, port: DEFAULT_REMOTE_PORT, token: null, trustOwnDevices: true });
    writeRemoteAccessConfig(file, { enabled: true, port: 50000, token: TOKEN, trustOwnDevices: false });
    assert.deepEqual(readRemoteAccessConfig(file), { enabled: true, port: 50000, token: TOKEN, trustOwnDevices: false });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    fs.writeFileSync(file, JSON.stringify({ enabled: "yes", port: 22, token: "guessable" }));
    assert.deepEqual(readRemoteAccessConfig(file), { enabled: false, port: DEFAULT_REMOTE_PORT, token: null, trustOwnDevices: true });
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readRemoteAccessConfig(file), { enabled: false, port: DEFAULT_REMOTE_PORT, token: null, trustOwnDevices: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const STATUS_JSON = {
  BackendState: "Running",
  User: {
    2539845234848443: { ID: 2539845234848443, LoginName: "alan@example.com", DisplayName: "Alan" },
    777: { ID: 777, LoginName: "friend@example.com" },
  },
  Self: {
    ID: "nSELF11CNTRL",
    UserID: 2539845234848443,
    HostName: "omarchy",
    DNSName: "omarchy.tail1234.ts.net.",
    OS: "linux",
    Online: true,
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1234", "10.0.0.1"],
  },
  Peer: {
    "nodekey:a": {
      ID: "nLAPTOP11CNTRL",
      UserID: 2539845234848443,
      HostName: "alan-Surface-Laptop-3",
      DNSName: "alan-surface-laptop-3.tail1234.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.124.147.99", "fd7a:115c:a1e0::b201:938e"],
    },
    "nodekey:b": {
      ID: "nSERVER11CNTRL",
      UserID: 123,
      HostName: "build-box",
      DNSName: "build-box.tail1234.ts.net.",
      OS: "linux",
      Online: false,
      TailscaleIPs: ["100.70.0.9"],
      Tags: ["tag:server"],
    },
  },
};

test("parseTailscaleStatus extracts this machine, its account, and its peers", () => {
  const status = parseTailscaleStatus(STATUS_JSON);
  assert.equal(status.backendState, "Running");
  assert.equal(status.dnsName, "omarchy.tail1234.ts.net");
  assert.equal(status.hostName, "omarchy");
  assert.deepEqual(status.addresses, ["100.101.102.103", "fd7a:115c:a1e0::1234"]);
  assert.deepEqual(status.self, {
    id: "nSELF11CNTRL",
    hostName: "omarchy",
    dnsName: "omarchy.tail1234.ts.net",
    os: "linux",
    online: true,
    addresses: ["100.101.102.103", "fd7a:115c:a1e0::1234"],
    userId: 2539845234848443,
    loginName: "alan@example.com",
    tags: [],
  });
  assert.equal(status.peers.length, 2);
  const server = status.peers.find((peer) => peer.id === "nSERVER11CNTRL");
  assert.deepEqual(server.tags, ["tag:server"]);
  assert.equal(server.online, false);
  assert.equal(server.loginName, null);
});

test("parseTailscaleStatus tolerates a signed-out or missing status", () => {
  assert.equal(parseTailscaleStatus(null), null);
  assert.deepEqual(parseTailscaleStatus({ BackendState: "NeedsLogin" }), {
    backendState: "NeedsLogin",
    dnsName: null,
    hostName: null,
    addresses: [],
    self: null,
    peers: [],
  });
});

const WHOIS_JSON = {
  Node: {
    ID: 2183935639504796,
    StableID: "nLAPTOP11CNTRL",
    Name: "alan-surface-laptop-3.tail1234.ts.net.",
    User: 2539845234848443,
    ComputedName: "alan-surface-laptop-3",
  },
  UserProfile: { ID: 2539845234848443, LoginName: "alan@example.com", DisplayName: "Alan" },
};

test("parseTailscaleWhois extracts the device and its owner", () => {
  assert.deepEqual(parseTailscaleWhois(WHOIS_JSON), {
    nodeId: "nLAPTOP11CNTRL",
    nodeName: "alan-surface-laptop-3",
    userId: 2539845234848443,
    loginName: "alan@example.com",
    displayName: "Alan",
    tags: [],
  });
  const tagged = parseTailscaleWhois({ Node: { StableID: "nX", Name: "ci.tail1234.ts.net.", Tags: ["tag:ci"], User: 5 } });
  assert.equal(tagged.nodeName, "ci");
  assert.deepEqual(tagged.tags, ["tag:ci"]);
  assert.equal(tagged.userId, 5);
  assert.equal(parseTailscaleWhois({}), null);
  assert.equal(parseTailscaleWhois("nope"), null);
});

test("isOwnDevice trusts other untagged devices of the same account only", () => {
  const self = parseTailscaleStatus(STATUS_JSON).self;
  const laptop = parseTailscaleWhois(WHOIS_JSON);
  assert.equal(isOwnDevice(laptop, self), true);
  assert.equal(isOwnDevice({ ...laptop, userId: 777, loginName: "friend@example.com" }, self), false, "someone else's device");
  assert.equal(isOwnDevice({ ...laptop, tags: ["tag:server"] }, self), false, "tagged peer");
  assert.equal(isOwnDevice(laptop, { ...self, tags: ["tag:server"] }), false, "tagged self: tagged nodes share a pseudo-user");
  assert.equal(isOwnDevice({ ...laptop, nodeId: "nSELF11CNTRL" }, self), false, "this machine itself");
  assert.equal(isOwnDevice({ ...laptop, userId: null }, self), false, "unknown owner");
  assert.equal(isOwnDevice(null, self), false);
  assert.equal(isOwnDevice(laptop, null), false);
});

test("evaluateRemoteAccess lets an own device in without a token, but only past the network checks", () => {
  const noToken = remoteRequest({ authorization: undefined });
  assert.deepEqual(evaluateRemoteAccess(noToken, { token: TOKEN, boundAddresses: BOUND, ownDevice: true }), { ok: true });
  assert.equal(evaluateRemoteAccess(noToken, { token: TOKEN, boundAddresses: BOUND, ownDevice: false }).status, 401);
  for (const overrides of [{ remoteAddress: "192.168.1.50" }, { host: "evil.example.com" }, { origin: "http://100.101.102.103:47821" }]) {
    const decision = evaluateRemoteAccess({ ...noToken, ...overrides }, { token: TOKEN, boundAddresses: BOUND, ownDevice: true });
    assert.equal(decision.status, 403, JSON.stringify(overrides));
  }
});

// The listener set is address-agnostic; loopback stands in for a Tailscale
// address so the bind/unbind/port-change behavior runs on any CI machine.
function get(port, pathname = "/") {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("RemoteListenerSet binds wanted addresses, moves ports, and closes cleanly", async () => {
  const listeners = new RemoteListenerSet((request, response) => {
    response.end(`hello from ${request.socket.localAddress}`);
  });
  const first = await freePort();
  await listeners.sync(["127.0.0.1"], first);
  assert.deepEqual(listeners.addresses, ["127.0.0.1"]);
  assert.equal(listeners.port, first);
  assert.deepEqual(await get(first), { status: 200, body: "hello from 127.0.0.1" });

  const second = await freePort();
  await listeners.sync(["127.0.0.1"], second);
  assert.equal(listeners.port, second);
  await assert.rejects(get(first), /ECONNREFUSED/);
  assert.equal((await get(second)).status, 200);

  await listeners.closeAll();
  assert.deepEqual(listeners.addresses, []);
  assert.equal(listeners.port, null);
  await assert.rejects(get(second), /ECONNREFUSED/);
});

test("RemoteListenerSet reports a port conflict instead of throwing, and recovers", async () => {
  const blocker = net.createServer();
  const port = await freePort();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  const listeners = new RemoteListenerSet((_request, response) => response.end("ok"));
  try {
    await listeners.sync(["127.0.0.1"], port);
    assert.deepEqual(listeners.addresses, []);
    assert.match(listeners.errors["127.0.0.1"], /already in use/);

    await new Promise((resolve) => blocker.close(resolve));
    await listeners.sync(["127.0.0.1"], port);
    assert.deepEqual(listeners.addresses, ["127.0.0.1"]);
    assert.deepEqual(listeners.errors, {});
  } finally {
    await listeners.closeAll();
    if (blocker.listening) await new Promise((resolve) => blocker.close(resolve));
  }
});

test("RemoteListenerSet serializes overlapping syncs", async () => {
  const listeners = new RemoteListenerSet((_request, response) => response.end("ok"));
  const port = await freePort();
  try {
    await Promise.all([
      listeners.sync(["127.0.0.1"], port),
      listeners.sync(["127.0.0.1"], port),
      listeners.sync([], port),
      listeners.sync(["127.0.0.1"], port),
    ]);
    assert.deepEqual(listeners.addresses, ["127.0.0.1"]);
    assert.equal((await get(port)).status, 200);
  } finally {
    await listeners.closeAll();
  }
});

test("a loopback caller is refused by the remote authorizer end to end", async () => {
  // Wire the real authorizer into a listener: a request that does not come from
  // a tailnet peer must never reach a route, even with the right token and Host.
  const listeners = new RemoteListenerSet((request, response) => {
    const decision = evaluateRemoteAccess(
      {
        remoteAddress: request.socket.remoteAddress,
        host: request.headers.host,
        authorization: request.headers.authorization,
      },
      { token: TOKEN, boundAddresses: ["127.0.0.1"] },
    );
    response.writeHead(decision.ok ? 200 : decision.status);
    response.end(decision.ok ? "routed" : decision.reason);
  });
  const port = await freePort();
  try {
    await listeners.sync(["127.0.0.1"], port);
    const result = await new Promise((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port, path: "/terminals", agent: false, headers: { authorization: `Bearer ${TOKEN}` } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        },
      );
      request.on("error", reject);
    });
    assert.equal(result.status, 403);
    assert.match(result.body, /tailnet/);
  } finally {
    await listeners.closeAll();
  }
});
