import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  compareAppImageVersions,
  findJarvisInstall,
  initialJarvisState,
  jarvisAlertEvent,
  jarvisBusUrl,
  jarvisControl,
  parseJarvisSession,
  readJarvisSession,
  reduceJarvisEvent,
  JARVIS_FEED_LIMIT,
} = await import("../dist-electron/jarvis-companion.js");

const licensed = { licensed: true, detail: null, offlineUntil: null, licenseId: "lic-1", keyMasked: null, instanceName: null };
const session = (overrides = {}) => ({
  version: 1,
  pid: process.pid,
  started_at: "2026-10-27T10:00:00Z",
  jarvis_version: "0.3.1",
  bus: { url: "ws://127.0.0.1:8973", token: "bus-token" },
  control: { endpoint: "tcp://127.0.0.1:8975", token: "c".repeat(64) },
  ...overrides,
});

test("a session is accepted only with loopback endpoints", () => {
  assert.equal(parseJarvisSession(session()).bus.token, "bus-token");
  assert.equal(parseJarvisSession(session({ control: { endpoint: "/run/user/1000/jarvis-control.sock", token: "" } })).control.token, "");
  assert.equal(parseJarvisSession(session({ bus: { url: "ws://10.0.0.5:8973", token: "x" } })), null, "never send the token off-machine");
  assert.equal(parseJarvisSession(session({ control: { endpoint: "tcp://example.com:8975", token: "x" } })), null);
  assert.equal(parseJarvisSession(session({ control: { endpoint: "relative.sock", token: "" } })), null);
  assert.equal(parseJarvisSession(session({ version: 2 })), null);
  assert.equal(parseJarvisSession(session({ pid: -1 })), null);
  assert.equal(parseJarvisSession("nope"), null);
});

test("the bus URL carries the session token", () => {
  assert.equal(jarvisBusUrl(parseJarvisSession(session())), "ws://127.0.0.1:8973/?token=bus-token");
  assert.equal(jarvisBusUrl(parseJarvisSession(session({ bus: { url: "ws://127.0.0.1:8973", token: "" } }))), "ws://127.0.0.1:8973/");
});

test("readJarvisSession ignores a session whose daemon has exited", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-jarvis-session-"));
  const env = { ...process.env, XDG_CONFIG_HOME: root };
  try {
    assert.equal(readJarvisSession(env), null);
    fs.mkdirSync(path.join(root, "jarvis"));
    const file = path.join(root, "jarvis", "session.json");
    fs.writeFileSync(file, JSON.stringify(session()));
    assert.equal(readJarvisSession(env).pid, process.pid);
    fs.writeFileSync(file, JSON.stringify(session({ pid: 2 ** 31 - 2 })));
    assert.equal(readJarvisSession(env), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control commands use Jarvis's token envelope over TCP", async () => {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line) => {
      const request = JSON.parse(line);
      seen.push(request);
      if (request.token !== "c".repeat(64)) socket.end("err unauthorized control request\n");
      else if (request.command === "mic toggle") socket.end("ok off\n");
      else socket.end("err unknown command\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const live = parseJarvisSession(session({ control: { endpoint: `tcp://127.0.0.1:${port}`, token: "c".repeat(64) } }));
    assert.equal(await jarvisControl(live, "mic toggle"), "off");
    assert.deepEqual(seen[0], { version: 1, token: "c".repeat(64), command: "mic toggle" });
    await assert.rejects(jarvisControl(live, "dance"), /unknown command/);
    const wrong = parseJarvisSession(session({ control: { endpoint: `tcp://127.0.0.1:${port}`, token: "w".repeat(64) } }));
    await assert.rejects(jarvisControl(wrong, "mic toggle"), /unauthorized/);
  } finally {
    server.close();
  }
  const closed = parseJarvisSession(session({ control: { endpoint: `tcp://127.0.0.1:${port}`, token: "x" } }));
  await assert.rejects(jarvisControl(closed, "status", 1000), /not reachable/);
});

test("control commands are bare lines on a Unix socket", { skip: process.platform === "win32" ? "no Unix sockets" : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-jarvis-sock-"));
  const socketPath = path.join(dir, "jarvis-control.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line) => socket.end(line === "status\n" ? "ok on\n" : "err unexpected\n"));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const live = parseJarvisSession(session({ control: { endpoint: socketPath, token: "" } }));
    assert.equal(await jarvisControl(live, "status"), "on");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bus events become a readable feed and live activity", () => {
  let id = 0;
  const nextId = () => ++id;
  let state = initialJarvisState(licensed);
  const apply = (event, now = 1_000) => {
    const next = reduceJarvisEvent(state, event, nextId, now);
    if (next) state = next;
    return next;
  };
  assert.equal(apply({ t: "tts.level", level: 0.4 }), null, "levels never wake listeners");
  apply({ t: "user.speaking", on: true });
  assert.equal(state.activity, "listening");
  apply({ t: "stt.partial", text: "spin up codex" });
  assert.equal(state.partial, "spin up codex");
  apply({ t: "stt.final", text: "spin up codex on omarchy" });
  apply({ t: "user.speaking", on: false });
  apply({ t: "jarvis.thinking", on: true });
  assert.equal(state.activity, "thinking");
  assert.equal(state.partial, null);
  apply({ t: "tts.text", text: "On it." }, 2_000);
  apply({ t: "tts.speaking", on: true });
  apply({ t: "tts.text", text: "Codex is starting on omarchy." }, 3_000);
  apply({ t: "tts.speaking", on: false });
  assert.equal(state.activity, "idle");
  assert.deepEqual(state.feed.map((item) => [item.kind, item.text]), [
    ["heard", "spin up codex on omarchy"],
    ["said", "On it. Codex is starting on omarchy."],
  ]);
  apply({ t: "stt.final", text: "what's running on omarchy?", source: "typed" });
  assert.deepEqual([state.feed.at(-1).kind, state.feed.at(-1).text], ["asked", "what's running on omarchy?"]);
  apply({ t: "agent.event", kind: "stop", agent: "codex", message: "tests pass" });
  assert.deepEqual(state.feed.at(-1), { id: state.feed.at(-1).id, at: 1_000, kind: "agent", text: "stop: tests pass", agent: "codex" });
  apply({ t: "mic.state", open: false });
  assert.equal(state.micOpen, false);
  apply({ t: "session.info", provider: "codex", model: "gpt-6.1-terra" });
  assert.equal(state.model, "gpt-6.1-terra");
  apply({ t: "agent.roster", agents: [{ name: "codex", cwd: "/repo", task: "", working: true, focused: true, status: "working" }, { bogus: 1 }] });
  assert.deepEqual(state.agents, [{ name: "codex", cwd: "/repo", task: null, working: true, focused: true, status: "working" }]);
});

test("the feed keeps only the most recent items", () => {
  let id = 0;
  let state = initialJarvisState(licensed);
  for (let index = 0; index < JARVIS_FEED_LIMIT + 5; index += 1) {
    state = reduceJarvisEvent(state, { t: "stt.final", text: `line ${index}` }, () => ++id, index);
  }
  assert.equal(state.feed.length, JARVIS_FEED_LIMIT);
  assert.equal(state.feed[0].text, "line 5");
});

test("agent alerts become events Jarvis can announce", () => {
  const alert = (overrides) => ({
    machine: "omarchy", agentKind: "codex", title: "codex", workspace: "/home/alan/athena", terminalId: "t1",
    kind: "update", reason: "turn-complete", message: null, ...overrides,
  });
  assert.deepEqual(jarvisAlertEvent(alert()), {
    type: "stop", source: "athena", agent: "codex on omarchy", message: "", machine: "omarchy", terminal_id: "t1", cwd: "/home/alan/athena",
  });
  assert.equal(jarvisAlertEvent(alert({ machine: null, workspace: "C:\\Users\\alan\\athena\\" })).agent, "codex in athena");
  const approval = jarvisAlertEvent(alert({ kind: "action", reason: "approval", message: "Waiting for your approval" }));
  assert.equal(approval.type, "notification");
  assert.equal(approval.message, "Waiting for your approval");
  assert.equal(jarvisAlertEvent(alert({ reason: "bell" })), null, "housekeeping stays quiet");
  assert.equal(jarvisAlertEvent(alert({ reason: "exit" })), null);
  assert.equal(jarvisAlertEvent(alert({ agentKind: "shell" })), null, "shells are not agents");
});

test("a Linux AppImage is found under its release name, newest version first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "athena-jarvis-appimage-"));
  try {
    assert.equal(findJarvisInstall({ HOME: home }, "linux"), null);
    fs.mkdirSync(path.join(home, "Applications"));
    fs.mkdirSync(path.join(home, "Downloads"));
    fs.writeFileSync(path.join(home, "Applications", "Jarvis.AI_0.3.2_amd64.AppImage"), "");
    assert.equal(findJarvisInstall({ HOME: home }, "linux"), path.join(home, "Applications", "Jarvis.AI_0.3.2_amd64.AppImage"));
    fs.writeFileSync(path.join(home, "Downloads", "Jarvis.AI_0.3.10_amd64.AppImage"), "");
    fs.writeFileSync(path.join(home, "Applications", "Jarvis.AI_0.3.9_amd64.AppImage"), "");
    fs.writeFileSync(path.join(home, "Applications", "Obsidian-1.9.12.AppImage"), "");
    assert.equal(findJarvisInstall({ HOME: home }, "linux"), path.join(home, "Downloads", "Jarvis.AI_0.3.10_amd64.AppImage"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.ok(compareAppImageVersions("Jarvis.AI_0.3.10_amd64.AppImage", "Jarvis.AI_0.3.9_amd64.AppImage") > 0);
  assert.ok(compareAppImageVersions("Jarvis-AI.AppImage", "Jarvis.AI_0.3.2_amd64.AppImage") < 0, "unversioned sorts last");
});

test("the Jarvis install is found where its installer puts it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-jarvis-install-"));
  try {
    assert.equal(findJarvisInstall({ LOCALAPPDATA: root }, "win32"), null);
    fs.mkdirSync(path.join(root, "Jarvis AI"));
    fs.writeFileSync(path.join(root, "Jarvis AI", "jarvis-hud.exe"), "");
    assert.equal(findJarvisInstall({ LOCALAPPDATA: root }, "win32"), path.join(root, "Jarvis AI", "jarvis-hud.exe"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
