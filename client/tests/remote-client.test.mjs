import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSseParser,
  isRemoteTerminalId,
  parseRemoteTerminalId,
  RemoteClient,
  RemoteTokenStore,
  remoteTerminalId,
  requestJson,
} from "../dist-electron/remote-client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("createSseParser handles split chunks, CRLF, comments, and multi-line data", () => {
  const messages = [];
  const feed = createSseParser((message) => messages.push(message));
  feed(": comment\n\nevent: hel");
  feed("lo\r\ndata: {\"a\":");
  feed("1}\r\n\r\n");
  feed("id: 7\ndata: line one\ndata: line two\n\n");
  feed("data:no-space\n\nevent: empty\n\n");
  assert.deepEqual(messages, [
    { event: "hello", data: "{\"a\":1}", id: null },
    { event: "message", data: "line one\nline two", id: "7" },
    { event: "message", data: "no-space", id: null },
  ]);
});

test("remote terminal ids round-trip and reject malformed ids", () => {
  const id = remoteTerminalId("nLAPTOP11CNTRL", "term-1:with-colon");
  assert.equal(id, "remote:nLAPTOP11CNTRL:term-1:with-colon");
  assert.equal(isRemoteTerminalId(id), true);
  assert.equal(isRemoteTerminalId("local-1"), false);
  assert.equal(isRemoteTerminalId(null), false);
  assert.deepEqual(parseRemoteTerminalId(id), { machineId: "nLAPTOP11CNTRL", terminalId: "term-1:with-colon" });
  for (const bad of ["remote:", "remote::x", "remote:m:", "remote:m", "local"]) {
    assert.equal(parseRemoteTerminalId(bad), null, bad);
  }
});

test("RemoteTokenStore keeps tokens 0600 and forgets cleared ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-tokens-"));
  try {
    const file = path.join(dir, "nested", "remote-tokens.json");
    const store = new RemoteTokenStore(file);
    assert.equal(store.get("nA"), null);
    store.set("nA", "  athena_remote_a  ");
    store.set("nB", "athena_remote_b");
    assert.equal(new RemoteTokenStore(file).get("nA"), "athena_remote_a");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    store.set("nA", null);
    store.set("nB", "   ");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestJson surfaces the host's error message and status", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "agent_not_installed", message: "Claude Code (claude) is not installed or not on PATH." }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(requestJson(`http://127.0.0.1:${server.address().port}/terminals/spawn`, { method: "POST", body: {} }), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.body.error, "agent_not_installed");
      assert.match(error.message, /not installed/);
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A fake host Athena: enough of the control API for the client, with hooks to
 * push events and terminal output and a log of every request.
 */
async function fakeHost({ history, chat } = {}) {
  const requests = [];
  const eventStreams = new Set();
  const terminalStreams = new Map();
  const terminals = new Map([["t1", session("t1", "Claude Builder", "/home/alan/app")]]);
  let workspaces = [{ nativePath: "/home/alan/app", wslPath: null, displayPath: "/home/alan/app" }];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const url = new URL(request.url, "http://host");
    requests.push({ method: request.method, path: url.pathname, query: url.search, body: json, authorization: request.headers.authorization ?? null });
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === "/agent-sessions" && history) return history({ url, send });
    if (url.pathname === "/terminals/t1/chat" && chat) return chat({ url, send });
    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: hello\ndata: ${JSON.stringify({ terminals: [...terminals.values()], workspaces, active: workspaces[0] })}\n\n`);
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    const streamMatch = /^\/terminals\/([^/]+)\/stream$/.exec(url.pathname);
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1]);
      if (!terminals.has(id)) {
        send(400, { error: `Error: Embedded terminal target not found: ${id}` });
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: snapshot\ndata: ${JSON.stringify({ epoch: "e1", throughSequence: 4, data: "$ hello\r\n" })}\n\n`);
      terminalStreams.set(id, response);
      response.on("close", () => {
        if (terminalStreams.get(id) === response) terminalStreams.delete(id);
      });
      return;
    }
    if (url.pathname === "/terminals") return send(200, { terminals: [...terminals.values()] });
    if (url.pathname === "/terminals/keys") return send(200, { written: true, terminal: terminals.get(json.terminal_id) });
    if (url.pathname === "/terminals/resize") {
      await sleep(20);
      return send(200, { resized: true, terminal: terminals.get(json.terminal_id) });
    }
    if (url.pathname === "/terminals/rename") {
      const renamed = { ...terminals.get(json.terminal_id), title: json.title };
      terminals.set(renamed.id, renamed);
      return send(200, { renamed: true, terminal: renamed });
    }
    if (url.pathname === "/terminals/kill") {
      terminals.delete(json.terminal_id);
      return send(200, { killed: true });
    }
    if (url.pathname === "/terminals/spawn") {
      const created = Array.from({ length: json.count }, (_, index) => session(`s${index}`, `${json.kind}-${index}`, json.project_dir));
      for (const item of created) terminals.set(item.id, item);
      return send(200, { sessions: created });
    }
    if (url.pathname === "/workspaces/open") {
      const opened = { nativePath: json.project_dir, wslPath: null, displayPath: json.project_dir };
      workspaces = [...workspaces, opened];
      return send(200, { workspace: opened, selected: json.select });
    }
    if (url.pathname === "/fs/dirs") return send(200, { path: url.searchParams.get("path") ?? "/home/alan", parent: "/home", home: "/home/alan", dirs: [], truncated: false });
    send(404, { error: "unknown" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    terminals,
    get eventStreamCount() {
      return eventStreams.size;
    },
    terminalStream: (id) => terminalStreams.get(id),
    pushEvent(event, payload) {
      for (const stream of eventStreams) stream.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    pushOutput(id, event, payload) {
      terminalStreams.get(id)?.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    dropEventStreams() {
      for (const stream of eventStreams) stream.destroy();
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

function session(id, title, workspace) {
  return {
    id, title, kind: "claude", workspace, pid: 100, promptPath: null, initialTask: null, sessionLabel: null,
    providerSessionId: null, createdAt: "2026-10-02T12:00:00.000Z", status: "running", exitCode: null, error: null,
  };
}

function machine(url, overrides = {}) {
  return {
    id: "nLAPTOP", name: "surface", dnsName: "surface.tail1234.ts.net", os: "linux", online: true, address: "100.124.147.99",
    url, owner: "alan@example.com", ownDevice: true, status: "ready", detail: null, version: "0.3.1", platform: "linux",
    homedir: "/home/alan", checkedAt: "2026-10-02T12:00:00.000Z", ...overrides,
  };
}

function client(host, { token = null, machines } = {}) {
  const broadcasts = [];
  const remote = new RemoteClient({
    discover: async () => ({ tailscale: "running", account: "alan@example.com", port: 47821, machines: machines ?? [machine(host.url)], refreshedAt: new Date().toISOString() }),
    tokenFor: () => token,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    selfName: () => "omarchy",
  });
  return { remote, broadcasts };
}

function subscriber(id = 1) {
  const received = [];
  return Object.assign(new EventEmitter(), { id, received, send: (channel, payload) => received.push({ channel, payload }), isDestroyed: () => false });
}

test("RemoteClient reads chat from the selected host and validates its response", async (t) => {
  let payload = { revision: "r1", messages: [{ id: "a", role: "assistant", text: "Remote reply", timestamp: null }] };
  const host = await fakeHost({ chat: ({ send }) => send(200, payload) });
  const { remote } = client(host, { token: "athena_remote_chat" });
  t.after(async () => { remote.dispose(); await host.close(); });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  assert.deepEqual(await remote.chatMessages("remote:nLAPTOP:t1"), payload);
  assert.equal(host.requests.find((item) => item.path === "/terminals/t1/chat").authorization, "Bearer athena_remote_chat");
  payload = { messages: "invalid" };
  await assert.rejects(remote.chatMessages("remote:nLAPTOP:t1"), /invalid conversation/);
  await assert.rejects(remote.chatMessages("remote:other:t1"), /not available|Unknown|not found/i);
});

test("RemoteClient connects to ready machines and mirrors their terminals and tabs", async (t) => {
  const host = await fakeHost();
  const { remote, broadcasts } = client(host, { token: "athena_remote_x" });
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  const view = remote.snapshot().machines[0];
  assert.equal(remote.snapshot().selfName, "omarchy");
  assert.equal(view.hasToken, true);
  assert.deepEqual(view.sessions.map((item) => [item.id, item.title]), [["remote:nLAPTOP:t1", "Claude Builder"]]);
  assert.deepEqual(view.workspaces.map((item) => item.nativePath), ["/home/alan/app"]);
  assert.equal(view.activeWorkspace.nativePath, "/home/alan/app");
  assert.equal(host.requests.find((item) => item.path === "/events").authorization, "Bearer athena_remote_x");
  await until(() => broadcasts.some((item) => item.channel === "remote:update" && item.payload.machines[0].connection === "connected"), "update broadcast");

  // New terminals and attention arrive over the event stream.
  host.pushEvent("session", session("t2", "Codex Reviewer", "/home/alan/app"));
  host.pushEvent("attention", { id: "t1", kind: "action", reason: "approval", message: null });
  host.pushEvent("workspaces", { workspaces: [{ nativePath: "/srv/api", wslPath: null, displayPath: "/srv/api" }], active: null });
  await until(() => remote.snapshot().machines[0].sessions.length === 2, "second session");
  await until(() => broadcasts.some((item) => item.channel === "remote:attention"), "attention relay");
  const attention = broadcasts.find((item) => item.channel === "remote:attention").payload;
  assert.equal(attention.machineName, "surface");
  assert.deepEqual(attention.event, { id: "remote:nLAPTOP:t1", kind: "action", reason: "approval", message: null });
  assert.equal(attention.session.title, "Claude Builder");
  assert.deepEqual(remote.snapshot().machines[0].workspaces.map((item) => item.nativePath), ["/srv/api"]);

  // An exit is relayed under the namespaced id and marks the session exited.
  host.pushEvent("exit", { id: "t2", exitCode: 0, epoch: "e9", throughSequence: 12 });
  await until(() => broadcasts.some((item) => item.channel === "embedded-terminal:exit"), "exit relay");
  assert.deepEqual(broadcasts.find((item) => item.channel === "embedded-terminal:exit").payload, {
    id: "remote:nLAPTOP:t2", exitCode: 0, epoch: "e9", throughSequence: 12,
  });
});

test("RemoteClient proxies a terminal stream into the local stream protocol", async (t) => {
  const host = await fakeHost();
  const { remote, broadcasts } = client(host);
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  const view = subscriber();
  const id = "remote:nLAPTOP:t1";
  remote.subscribe(id, view);
  const snapshot = await remote.attach(id, view);
  assert.deepEqual(snapshot, { id, epoch: "e1", buffer: "$ hello\r\n", throughSequence: 4 });
  const streamRequest = host.requests.find((item) => item.path === "/terminals/t1/stream");
  assert.match(streamRequest.query, /format=json/);

  host.pushOutput("t1", "data", { epoch: "e1", fromSequence: 5, sequence: 6, data: "more\r\n" });
  host.pushOutput("t1", "snapshot", { epoch: "e1", throughSequence: 9, data: "rebased" });
  host.pushOutput("t1", "exit", { exitCode: 3, epoch: "e1", throughSequence: 9 });
  await until(() => view.received.length === 2 && broadcasts.some((item) => item.channel === "embedded-terminal:exit"), "relayed output");
  assert.deepEqual(view.received, [
    { channel: "embedded-terminal:data", payload: { id, epoch: "e1", fromSequence: 5, sequence: 6, data: "more\r\n", reset: false } },
    { channel: "embedded-terminal:data", payload: { id, epoch: "e1", fromSequence: 0, sequence: 9, data: "rebased", reset: true } },
  ]);
  assert.deepEqual(broadcasts.find((item) => item.channel === "embedded-terminal:exit").payload, { id, exitCode: 3, epoch: "e1", throughSequence: 9 });
});

test("RemoteClient keeps keystrokes in order and coalesces them while a request is in flight", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host);
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  const id = "remote:nLAPTOP:t1";
  const keys = "echo hi-from-the-laptop\r".split("");
  await Promise.all(keys.map((key) => remote.write(id, key)));
  const sent = host.requests.filter((item) => item.path === "/terminals/keys");
  assert.equal(sent.map((item) => item.body.data).join(""), keys.join(""), "every byte, in order");
  assert.ok(sent.length < keys.length, `batched (${sent.length} requests for ${keys.length} keys)`);
  assert.ok(sent.every((item) => item.body.terminal_id === "t1"));
});

test("RemoteClient coalesces resizes and always lands on the last size", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host);
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  const id = "remote:nLAPTOP:t1";
  await Promise.all([remote.resize(id, 80, 24), remote.resize(id, 90, 25), remote.resize(id, 100, 30), remote.resize(id, 120, 40)]);
  await until(() => {
    const sent = host.requests.filter((item) => item.path === "/terminals/resize");
    return sent.at(-1)?.body.cols === 120;
  }, "final resize");
  const sent = host.requests.filter((item) => item.path === "/terminals/resize");
  assert.ok(sent.length <= 2, `coalesced to ${sent.length} requests`);
  assert.deepEqual({ cols: sent.at(-1).body.cols, rows: sent.at(-1).body.rows }, { cols: 120, rows: 40 });
});

test("RemoteClient spawns without stealing the host's tab, and renames, kills, and browses", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host);
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  const created = await remote.spawn("nLAPTOP", { workspace: "/home/alan/app", kind: "codex", count: 2 });
  assert.deepEqual(created.map((item) => item.id), ["remote:nLAPTOP:s0", "remote:nLAPTOP:s1"]);
  const spawn = host.requests.find((item) => item.path === "/terminals/spawn").body;
  assert.equal(spawn.open_workspace, true);
  assert.equal(spawn.select_workspace, false, "never switches the tab on the host");
  assert.equal(remote.snapshot().machines[0].sessions.length, 3);

  const renamed = await remote.rename("remote:nLAPTOP:s0", "Codex Scout");
  assert.equal(renamed.title, "Codex Scout");
  assert.equal(renamed.id, "remote:nLAPTOP:s0");

  const killed = await remote.kill("remote:nLAPTOP:s1");
  assert.equal(killed.status, "exited");
  assert.equal(host.requests.find((item) => item.path === "/terminals/kill").body.terminal_id, "s1");
  assert.equal(remote.snapshot().machines[0].sessions.some((item) => item.id === "remote:nLAPTOP:s1"), false);

  const opened = await remote.openWorkspace("nLAPTOP", "/srv/api");
  assert.equal(opened.nativePath, "/srv/api");
  assert.equal(host.requests.find((item) => item.path === "/workspaces/open").body.select, false);
  assert.ok(remote.snapshot().machines[0].workspaces.some((item) => item.nativePath === "/srv/api"));

  const listing = await remote.listDirectories("nLAPTOP", "/home/alan/src");
  assert.equal(listing.path, "/home/alan/src");
  await remote.spawn("nLAPTOP", { workspace: "C:\\Work\\App", kind: "claude", resumeSessionId: "original-id", sessionLabel: "Continue work" });
  const resume = host.requests.filter((item) => item.path === "/terminals/spawn").at(-1).body;
  assert.equal(resume.project_dir, "C:\\Work\\App");
  assert.equal(resume.resume_session_id, "original-id");
  assert.equal(resume.session_label, "Continue work");
  assert.equal(resume.count, 1);
  assert.equal(resume.select_workspace, false);
});

test("slow remote history does not block input or sequenced output and is never included in machine broadcasts", async (t) => {
  let finish;
  const host = await fakeHost({ history: ({ send }) => { finish = () => send(200, { sessions: [], nextCursor: null, warning: null }); } });
  const { remote, broadcasts } = client(host, { token: "history-token" });
  t.after(async () => { remote.dispose(); await host.close(); });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  assert.equal(host.requests.filter((r) => r.path === "/agent-sessions").length, 0);
  const view = subscriber();
  remote.subscribe("remote:nLAPTOP:t1", view);
  await remote.attach("remote:nLAPTOP:t1", view);
  const history = remote.listAgentSessions("nLAPTOP", "C:\\Work\\Case & space", "next:100");
  await until(() => finish, "history request");
  const request = host.requests.find((r) => r.path === "/agent-sessions");
  assert.equal(new URLSearchParams(request.query).get("workspace"), "C:\\Work\\Case & space");
  assert.equal(new URLSearchParams(request.query).get("cursor"), "next:100");
  assert.equal(request.authorization, "Bearer history-token");
  await remote.write("remote:nLAPTOP:t1", "echo ready\r");
  for (let sequence = 5; sequence < 105; sequence++) {
    host.pushOutput("t1", "data", { epoch: "e1", fromSequence: sequence, sequence, data: "streaming\r\n" });
  }
  await until(() => view.received.length === 100, "output while history pending");
  assert.ok(host.requests.some((r) => r.path === "/terminals/keys"));
  finish();
  assert.deepEqual(await history, { sessions: [], nextCursor: null, warning: null });
  assert.ok(broadcasts.filter((b) => b.channel === "remote:update").every((b) => !JSON.stringify(b.payload).includes("nextCursor")));
});

test("old hosts show an update message without disabling terminals", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host);
  t.after(async () => { remote.dispose(); await host.close(); });
  await remote.refresh();
  await assert.rejects(remote.listAgentSessions("nLAPTOP", "/work"), /Update Athena on this device/);
  assert.equal((await remote.spawn("nLAPTOP", { workspace: "/work", kind: "shell" })).length, 1);
  assert.equal(host.requests.filter((r) => r.path === "/agent-sessions").length, 1);
});

test("history response limits and schema validation reject oversized or malformed replies", async (t) => {
  let payload = { sessions: [{ id: "bad" }], nextCursor: null, warning: null };
  const host = await fakeHost({ history: ({ send }) => send(200, payload) });
  const { remote } = client(host);
  t.after(async () => { remote.dispose(); await host.close(); });
  await remote.refresh();
  await assert.rejects(remote.listAgentSessions("nLAPTOP", "/work"), /invalid session history/);
  payload = { sessions: [], nextCursor: null, warning: "x".repeat(300_000) };
  await assert.rejects(remote.listAgentSessions("nLAPTOP", "/work"), /size limit/);
});

test("bounded JSON requests have an absolute deadline even if the peer trickles data", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => response.write(" "), 5);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(requestJson(`http://127.0.0.1:${server.address().port}`, { deadlineMs: 80, timeoutMs: 500 }), /did not answer in time/);
});

test("RemoteClient reconnects a dropped event stream", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host);
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  host.dropEventStreams();
  await until(() => remote.snapshot().machines[0].connection === "error", "error state");
  await until(() => remote.snapshot().machines[0].connection === "connected", "reconnected", 4000);
  assert.equal(host.requests.filter((item) => item.path === "/events").length, 2);
});

test("RemoteClient keeps a healthy stream through failed probes but closes it for offline or unauthorized peers", async (t) => {
  const host = await fakeHost();
  const machines = [machine(host.url)];
  const { remote } = client(host, { machines });
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0].connection === "connected", "connection");
  const view = subscriber();
  await remote.attach("remote:nLAPTOP:t1", view);
  const stream = host.terminalStream("t1");
  for (const status of ["no-athena", "unknown", "no-athena"]) {
    machines[0] = machine(host.url, { status, detail: "probe timed out", homedir: null, version: null });
    await remote.refresh();
    const snapshot = remote.snapshot().machines[0];
    assert.equal(snapshot.connection, "connected");
    assert.equal(snapshot.status, "ready", "the switcher keeps the machine available");
    assert.equal(snapshot.homedir, "/home/alan");
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(host.terminalStream("t1"), stream);
  }
  host.pushOutput("t1", "data", { epoch: "e1", fromSequence: 5, sequence: 5, data: "still live" });
  await until(() => view.received.length === 1, "output after failed probe");
  assert.equal(host.requests.filter((item) => item.path === "/events").length, 1, "no reconnection");

  for (const overrides of [{ status: "offline", online: false }, { status: "needs-token" }, { status: "refused" }]) {
    machines[0] = machine(host.url, overrides);
    await remote.refresh();
    assert.equal(remote.snapshot().machines[0].connection, "idle");
    assert.equal(remote.snapshot().machines[0].sessions.length, 0);
    await until(() => host.eventStreamCount === 0 && !host.terminalStream("t1"), "streams closed");
    machines[0] = machine(host.url);
    await remote.refresh();
    await until(() => remote.snapshot().machines[0].connection === "connected", "recovery");
    await remote.attach("remote:nLAPTOP:t1", view);
  }
});

for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
  test(`RemoteClient drops all streams for a window on ${event} and accepts new subscriptions`, async (t) => {
    const host = await fakeHost();
    host.terminals.set("t2", session("t2", "Codex", "/home/alan/app"));
    const { remote } = client(host);
    t.after(async () => {
      remote.dispose();
      await host.close();
    });
    await remote.refresh();
    await until(() => remote.snapshot().machines[0].connection === "connected", "connection");
    const first = subscriber(1);
    const second = subscriber(2);
    await remote.attach("remote:nLAPTOP:t1", first);
    await remote.attach("remote:nLAPTOP:t2", first);
    remote.subscribe("remote:nLAPTOP:t2", second);
    assert.equal(first.listenerCount(event), 1, "one lifecycle hook per window");
    first.emit(event);
    await until(() => !host.terminalStream("t1"), "first window's private stream closed");
    assert.ok(host.terminalStream("t2"), "the other window keeps its shared stream");
    host.pushOutput("t2", "data", { epoch: "e1", fromSequence: 5, sequence: 5, data: "second window" });
    await until(() => second.received.length === 1, "other window's output");
    assert.equal(first.received.length, 0, "no data sent to the old document");
    remote.unsubscribe("remote:nLAPTOP:t2", second.id);
    await until(() => !host.terminalStream("t2"), "shared stream closed");
    // Reload/crash reuses WebContents; a destroyed window is replaced.
    const next = event === "destroyed" ? subscriber(3) : first;
    await remote.attach("remote:nLAPTOP:t1", next);
    assert.ok(host.terminalStream("t1"));
    remote.dispose();
    for (const target of [first, second, next]) {
      assert.equal(target.listenerCount("did-navigate"), 0);
      assert.equal(target.listenerCount("render-process-gone"), 0);
      assert.equal(target.listenerCount("destroyed"), 0);
    }
  });
}

test("RemoteClient closes a terminal stream when its last view goes away", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host);
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines[0]?.connection === "connected", "connection");
  const id = "remote:nLAPTOP:t1";
  const first = subscriber(1);
  const second = subscriber(2);
  remote.subscribe(id, first);
  remote.subscribe(id, second);
  await remote.attach(id, first);
  await until(() => Boolean(host.terminalStream("t1")), "host stream");
  remote.unsubscribe(id, 1);
  await sleep(50);
  assert.ok(host.terminalStream("t1"), "still open for the second view");
  remote.unsubscribe(id, 2);
  await until(() => !host.terminalStream("t1"), "host stream closed");
});

test("RemoteClient refuses unknown machines and missing terminals clearly", async (t) => {
  const host = await fakeHost();
  const { remote } = client(host, { machines: [machine(host.url), machine("http://127.0.0.1:9", { id: "nWIN", name: "win-pc", status: "no-athena" })] });
  t.after(async () => {
    remote.dispose();
    await host.close();
  });
  await remote.refresh();
  await until(() => remote.snapshot().machines.find((item) => item.id === "nLAPTOP")?.connection === "connected", "connection");
  assert.equal(remote.snapshot().machines.find((item) => item.id === "nWIN").connection, "idle", "not-ready machines are not connected");
  await assert.rejects(remote.spawn("nWIN", { workspace: "/x", kind: "shell" }), /win-pc is not ready/);
  await assert.rejects(remote.spawn("nNOPE", { workspace: "/x", kind: "shell" }), /Unknown machine/);
  await assert.rejects(remote.attach("remote:nLAPTOP:missing", subscriber()), /not found/);
  await assert.rejects(remote.write("not-remote", "x"), /Not a remote terminal/);
});
