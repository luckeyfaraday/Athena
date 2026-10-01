import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRemotePortInput,
  preferredRemoteUrl,
  remoteAccessCurlExample,
  remoteAccessStatusView,
  remoteActivitySummary,
} from "../src/remote-access-view.ts";

function state(overrides = {}) {
  return {
    enabled: true,
    port: 47821,
    urls: ["http://100.101.102.103:47821"],
    dnsUrl: null,
    tailscale: { detected: true, backendState: "Running", dnsName: null, hostName: "arch-desktop" },
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
    remoteAccessStatusView(state({ urls: [], errors: ["No Tailscale"], tailscale: { detected: false, backendState: null, dnsName: null, hostName: null } })),
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
  assert.match(example, /curl -H "Authorization: Bearer \$ATHENA_TOKEN" http:\/\/100\.101\.102\.103:47821\/machine/);
  assert.match(example, /<paste token>/);
  assert.match(remoteAccessCurlExample(null), /http:\/\/<this-machine>:47821/);
});

test("remoteActivitySummary reports the last accepted and rejected requests", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  assert.equal(remoteActivitySummary(state({ enabled: false }), now), "Remote access is off.");
  assert.equal(remoteActivitySummary(state(), now), "No remote requests yet.");
  const summary = remoteActivitySummary(state({
    lastRequest: { at: "2026-10-01T11:58:00Z", peer: "100.90.1.2", method: "GET", path: "/terminals" },
    lastRejected: { at: "2026-10-01T11:59:55Z", peer: "100.90.1.3", status: 401, reason: "Missing or invalid remote access token." },
  }), now);
  assert.equal(
    summary,
    "Last request 2m ago from 100.90.1.2 (GET /terminals). Last rejected just now from 100.90.1.3: Missing or invalid remote access token.",
  );
});

test("parseRemotePortInput accepts whole unprivileged ports only", () => {
  assert.equal(parseRemotePortInput(" 47821 "), 47821);
  for (const value of ["", "80", "65536", "47821a", "4782.1", "-1"]) {
    assert.equal(parseRemotePortInput(value), null, value);
  }
});
