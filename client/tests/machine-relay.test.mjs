import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { listRelayMachines, relayAllowed, relayToMachine, setMachineRelaySource } = await import("../dist-electron/machine-relay.js");

// A stand-in remote Athena: records what it was asked and answers like the
// real control API, including its error bodies.
const seen = [];
const remote = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    seen.push({ method: request.method, url: request.url, auth: request.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.url === "/terminals") send(200, { terminals: [{ id: "t1", kind: "codex" }] });
    else if (request.url === "/terminals/spawn") send(409, { error: "agent_not_installed", agent: "grok", install_command: "npm i -g grok" });
    else send(404, { error: "nope" });
  });
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${remote.address().port}`;
test.after(() => remote.close());

const machine = (overrides) => ({
  id: "nOMARCHY", name: "omarchy", dnsName: null, os: "linux", online: true, address: "100.1.2.3", url, owner: null, ownDevice: true,
  status: "ready", detail: null, version: "0.4.2", platform: "linux", homedir: "/home/alan", checkedAt: null,
  connection: "connected", connectionError: null, hasToken: true, workspaces: [], activeWorkspace: null,
  sessions: [{ id: "remote:nOMARCHY:t1", title: "codex", kind: "codex", workspace: "/home/alan/athena", status: "running", createdAt: "2026-10-27T10:00:00.000Z" }],
  ...overrides,
});

function useMachines(machines) {
  setMachineRelaySource({
    snapshot: async () => ({ tailscale: "running", account: null, selfName: "laptop", machines, refreshedAt: null }),
    tokenFor: (id) => (id === "nOMARCHY" ? "athena_remote_secret" : null),
  });
}

test("only request/response routes that drive agents are relayed", () => {
  assert.equal(relayAllowed("POST", "/terminals/spawn"), true);
  assert.equal(relayAllowed("GET", "/terminals/codex%231/chat"), true);
  assert.equal(relayAllowed("POST", "/hermes/ask"), true);
  assert.equal(relayAllowed("GET", "/events"), false, "streams stay direct");
  assert.equal(relayAllowed("GET", "/terminals/t1/stream"), false);
  assert.equal(relayAllowed("GET", "/machines"), false, "no hopping through a second machine");
  assert.equal(relayAllowed("POST", "/jarvis/ask"), false, "each machine's Jarvis is its own");
  assert.equal(relayAllowed("DELETE", "/terminals"), false);
});

test("machines list their agents under the remote's own terminal ids", async () => {
  useMachines([machine()]);
  const { machines } = await listRelayMachines();
  assert.deepEqual(machines[0].agents, [{ id: "t1", title: "codex", kind: "codex", workspace: "/home/alan/athena", status: "running", createdAt: "2026-10-27T10:00:00.000Z" }]);
});

test("a relayed request carries that machine's token and passes its answer through", async () => {
  useMachines([machine()]);
  seen.length = 0;
  assert.deepEqual(await relayToMachine("nOMARCHY", "GET", "/terminals", undefined), { status: 200, body: { terminals: [{ id: "t1", kind: "codex" }] } });
  assert.equal(seen[0].auth, "Bearer athena_remote_secret");
  const spawn = await relayToMachine("omarchy", "POST", "/terminals/spawn", { kind: "grok", project_dir: "/home/alan/x" });
  assert.equal(spawn.status, 409, "the remote's own status survives the relay");
  assert.equal(spawn.body.install_command, "npm i -g grok");
  assert.deepEqual(seen[1].body, { kind: "grok", project_dir: "/home/alan/x" });
});

test("machines that are not ready explain themselves without a request", async () => {
  useMachines([machine({ status: "needs-token" }), machine({ id: "nPI", name: "pi", status: "no-athena" })]);
  seen.length = 0;
  const token = await relayToMachine("nOMARCHY", "GET", "/terminals", undefined);
  assert.equal(token.status, 409);
  assert.match(token.body.error, /pair it in Athena's settings/);
  assert.match((await relayToMachine("pi", "GET", "/terminals", undefined)).body.error, /isn't answering on pi/);
  assert.equal((await relayToMachine("nowhere", "GET", "/terminals", undefined)).status, 404);
  assert.equal((await relayToMachine("nOMARCHY", "GET", "/events", undefined)).status, 404);
  assert.equal(seen.length, 0);
});

test("without a machine directory nothing is relayed", async () => {
  setMachineRelaySource(null);
  assert.deepEqual(await listRelayMachines(), { tailscale: "unavailable", machines: [] });
  assert.equal((await relayToMachine("nOMARCHY", "GET", "/terminals", undefined)).status, 503);
});
