import assert from "node:assert/strict";
import test from "node:test";

import {
  machineDetail,
  machinesSummary,
  machineStatusView,
  parseRemotePortInput,
  preferredRemoteUrl,
  remoteAccessCurlExample,
  remoteAccessStatusView,
  remoteActivitySummary,
  trustOwnDevicesHelp,
} from "../src/remote-access-view.ts";

function state(overrides = {}) {
  return {
    enabled: true,
    port: 47821,
    urls: ["http://100.101.102.103:47821"],
    dnsUrl: null,
    trustOwnDevices: true,
    tailscale: { detected: true, backendState: "Running", dnsName: null, hostName: "arch-desktop", account: "alan@example.com" },
    hasToken: true,
    errors: [],
    lastRequest: null,
    lastRejected: null,
    ...overrides,
  };
}

test("remoteAccessStatusView shows no pill while off", () => {
  assert.equal(remoteAccessStatusView(null), null);
  assert.equal(remoteAccessStatusView(state({ enabled: false })), null);
});

test("remoteAccessStatusView distinguishes listening, partial, waiting, and failed", () => {
  assert.deepEqual(remoteAccessStatusView(state()), { tone: "ok", label: "Listening" });
  assert.deepEqual(remoteAccessStatusView(state({ errors: ["IPv6 bind failed"] })), { tone: "warn", label: "Partly listening" });
  assert.deepEqual(
    remoteAccessStatusView(state({ urls: [], errors: ["No Tailscale"], tailscale: { detected: false, backendState: null, dnsName: null, hostName: null, account: null } })),
    { tone: "warn", label: "Waiting for Tailscale" },
  );
  assert.deepEqual(remoteAccessStatusView(state({ urls: [], errors: ["Port in use"] })), { tone: "bad", label: "Not listening" });
});

test("preferredRemoteUrl prefers MagicDNS, then the first address", () => {
  assert.equal(preferredRemoteUrl(state({ dnsUrl: "http://arch-desktop.tail1234.ts.net:47821" })), "http://arch-desktop.tail1234.ts.net:47821");
  assert.equal(preferredRemoteUrl(state()), "http://100.101.102.103:47821");
  assert.equal(preferredRemoteUrl(state({ enabled: false })), null);
  assert.equal(preferredRemoteUrl(state({ urls: [] })), null);
});

test("remoteAccessCurlExample never embeds the token", () => {
  const example = remoteAccessCurlExample(state());
  assert.match(example, /^# On another machine signed in to your Tailscale account:\ncurl http:\/\/100\.101\.102\.103:47821\/machine$/m);
  assert.match(example, /curl -H "Authorization: Bearer \$ATHENA_TOKEN" http:\/\/100\.101\.102\.103:47821\/machine/);
  assert.match(example, /<paste token>/);
  assert.match(remoteAccessCurlExample(null), /http:\/\/<this-machine>:47821/);
});

test("remoteAccessCurlExample shows only the token form when trust is off", () => {
  const example = remoteAccessCurlExample(state({ trustOwnDevices: false }));
  assert.doesNotMatch(example, /^curl http/m);
  assert.match(example, /^# On another machine on your tailnet, with this machine's token:/);
});

test("remoteActivitySummary reports the last accepted and rejected requests", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  assert.equal(remoteActivitySummary(state({ enabled: false }), now), "Remote access is off.");
  assert.equal(remoteActivitySummary(state(), now), "No remote requests yet.");
  const summary = remoteActivitySummary(state({
    lastRequest: { at: "2026-10-01T11:58:00Z", peer: "100.90.1.2", device: "surface", via: "account", method: "GET", path: "/terminals" },
    lastRejected: { at: "2026-10-01T11:59:55Z", peer: "100.90.1.3", device: null, status: 401, reason: "Missing or invalid remote access token." },
  }), now);
  assert.equal(
    summary,
    "Last request 2m ago from surface (100.90.1.2) (your account, GET /terminals). Last rejected just now from 100.90.1.3: Missing or invalid remote access token.",
  );
  const byToken = remoteActivitySummary(state({
    lastRequest: { at: "2026-10-01T10:00:00Z", peer: "100.90.1.2", device: null, via: "token", method: "POST", path: "/terminals/spawn" },
  }), now);
  assert.equal(byToken, "Last request 2h ago from 100.90.1.2 (token, POST /terminals/spawn).");
});

test("parseRemotePortInput accepts whole unprivileged ports only", () => {
  assert.equal(parseRemotePortInput(" 47821 "), 47821);
  for (const value of ["", "80", "65536", "47821a", "4782.1", "-1"]) {
    assert.equal(parseRemotePortInput(value), null, value);
  }
});

test("trustOwnDevicesHelp names the account and the fallback", () => {
  assert.match(trustOwnDevicesHelp(state()), /signed in to your Tailscale account \(alan@example\.com\) connect without the token/);
  assert.match(trustOwnDevicesHelp(state({ trustOwnDevices: false })), /^Off: every device needs the access token/);
  assert.match(trustOwnDevicesHelp(null), /^Off: every device needs the access token/);
});

function machine(overrides = {}) {
  return {
    id: "nLAPTOP",
    name: "surface",
    dnsName: "surface.tail1234.ts.net",
    os: "linux",
    online: true,
    address: "100.124.147.99",
    url: "http://100.124.147.99:47821",
    owner: "alan@example.com",
    ownDevice: true,
    status: "ready",
    detail: null,
    version: "0.3.1",
    platform: "linux",
    homedir: "/home/alan",
    checkedAt: "2026-10-02T12:00:00Z",
    ...overrides,
  };
}

test("machineStatusView maps every state to a pill", () => {
  assert.deepEqual(machineStatusView(machine()), { tone: "ok", label: "Ready" });
  assert.deepEqual(machineStatusView(machine({ status: "needs-token" })), { tone: "warn", label: "Needs token" });
  assert.deepEqual(machineStatusView(machine({ status: "refused" })), { tone: "bad", label: "Refused" });
  assert.deepEqual(machineStatusView(machine({ status: "no-athena" })), { tone: "muted", label: "Not answering" });
  assert.deepEqual(machineStatusView(machine({ status: "offline" })), { tone: "muted", label: "Offline" });
  assert.deepEqual(machineStatusView(machine({ status: "unknown" })), { tone: "warn", label: "Unknown" });
});

test("machineDetail explains what the machine is and why it is in its state", () => {
  assert.equal(machineDetail(machine()), "Linux · 100.124.147.99 — Athena 0.3.1");
  assert.equal(
    machineDetail(machine({ os: "windows", status: "no-athena", detail: "Athena is not running there, or its remote access is off.", version: null })),
    "Windows · 100.124.147.99 — Athena is not running there, or its remote access is off.",
  );
  assert.equal(machineDetail(machine({ status: "offline", version: null })), "Linux · 100.124.147.99 — Offline in Tailscale");
  assert.equal(
    machineDetail(machine({ ownDevice: false, owner: "friend@example.com", status: "needs-token", detail: "Needs this machine's access token." })),
    "Linux · 100.124.147.99 · shared by friend@example.com — Needs this machine's access token.",
  );
});

test("machinesSummary covers Tailscale states and readiness", () => {
  assert.equal(machinesSummary(null), "Looking for your machines…");
  assert.match(machinesSummary({ tailscale: "unavailable", machines: [] }), /Tailscale isn't running/);
  assert.match(machinesSummary({ tailscale: "stopped", machines: [] }), /not connected/);
  assert.equal(machinesSummary({ tailscale: "running", machines: [] }), "No other computers on your tailnet yet.");
  assert.equal(machinesSummary({ tailscale: "running", machines: [machine(), machine({ status: "offline" })] }), "1 of 2 machines has Athena ready for this one.");
  assert.equal(machinesSummary({ tailscale: "running", machines: [machine({ status: "no-athena" })] }), "Your other machine doesn't have Athena remote access on yet.");
  assert.equal(
    machinesSummary({ tailscale: "running", machines: [machine({ status: "no-athena" }), machine({ status: "offline" })] }),
    "None of your 2 other machines have Athena remote access on yet.",
  );
});
