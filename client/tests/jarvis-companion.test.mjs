import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { register } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The control server imports Electron's window facade; nothing else is replaced.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,export const app = { getVersion: () => "test" }; export const BrowserWindow = { getAllWindows: () => [] };', shortCircuit: true };
    return next(specifier, context);
  }
`)}`);

const {
  compareAppImageVersions,
  findJarvisInstall,
  initialJarvisState,
  jarvisAlertEvent,
  jarvisAskTurn,
  jarvisBridge,
  jarvisBusUrl,
  jarvisControl,
  parseJarvisSession,
  readJarvisSession,
  reduceJarvisEvent,
  JarvisAudioStore,
  JarvisBridge,
  JarvisLevelStream,
  JARVIS_AUDIO_MAX_BYTES,
  JARVIS_LEVEL_HZ,
  JARVIS_AUDIO_TURNS,
  JARVIS_FEED_LIMIT,
} = await import("../dist-electron/jarvis-companion.js");
const { createControlRequestListener } = await import("../dist-electron/control-server.js");

const licensed = { licensed: true, detail: null, offlineUntil: null, licenseId: "lic-1", keyMasked: null, instanceName: null };
const unlicensed = { licensed: false, detail: "Jarvis is not activated on this computer", offlineUntil: null, licenseId: null, keyMasked: null, instanceName: null };
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

// ── Companion replies: Jarvis speaks for the phone instead of on this computer ──

/** A mono 16-bit WAV of `size` bytes in all, as Jarvis sends one sentence. */
function wav(size = 64, sampleRate = 24_000) {
  const bytes = Buffer.alloc(Math.max(size, 44));
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8, "latin1");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "latin1");
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

const sentence = (turn, seq, size = 64) => ({ t: "tts.audio", turn, seq, format: "wav", sample_rate: 24_000, data: wav(size).toString("base64") });
const ending = (turn, seq, interrupted = false) => ({ t: "tts.audio", turn, seq, final: true, ...(interrupted ? { interrupted: true } : {}) });

test("an ask's answer names its turn, or none from a Jarvis that predates turns", () => {
  assert.equal(jarvisAskTurn('{"turn": "t-7"}'), "t-7");
  assert.equal(jarvisAskTurn("asked"), null);
  assert.equal(jarvisAskTurn('{"turn": 7}'), null);
  assert.equal(jarvisAskTurn('{"turn": ""}'), null);
  assert.equal(jarvisAskTurn(""), null);
});

test("reply audio is held by turn and sentence, oldest reply out first", () => {
  assert.equal(JARVIS_AUDIO_TURNS, 8);
  assert.equal(JARVIS_AUDIO_MAX_BYTES, 16 * 1024 * 1024);
  const store = new JarvisAudioStore({ turns: 2, bytes: 1_000 });
  assert.deepEqual(store.add(sentence("a", 0)), { turn: "a", seq: 0, final: false, interrupted: false });
  assert.equal(store.get("a", 0).sampleRate, 24_000);
  assert.deepEqual(store.get("a", 0).wav, wav());
  assert.equal(store.get("a", 1), null);
  assert.equal(store.get("b", 0), null);

  for (const malformed of [
    { ...sentence("a", 1), t: "tts.text" },
    { ...sentence("a", 1), turn: "" },
    { ...sentence("a", 1), turn: "x".repeat(129) },
    { ...sentence("a", 1), seq: -1 },
    { ...sentence("a", 1), seq: 1.5 },
    { ...sentence("a", 1), format: "mp3" },
    { ...sentence("a", 1), sample_rate: 0 },
    { ...sentence("a", 1), data: Buffer.from("not a wav file at all").toString("base64") },
    "nope",
  ]) {
    assert.equal(store.add(malformed), null, JSON.stringify(malformed).slice(0, 80));
  }
  assert.deepEqual(store.size(), { turns: 1, bytes: 64 });

  // The final marker ends the reply: nothing later is taken for it.
  assert.deepEqual(store.add(ending("a", 1)), { turn: "a", seq: 1, final: true, interrupted: false });
  assert.equal(store.add(sentence("a", 1)), null);
  assert.equal(store.add(ending("a", 1)), null);
  assert.equal(store.get("a", 0).wav.length, 64, "a finished reply stays fetchable");
  // A reply cut off before its first sentence still ends.
  assert.deepEqual(store.add(ending("b", 0, true)), { turn: "b", seq: 0, final: true, interrupted: true });

  // A third reply pushes the oldest out.
  store.add(sentence("c", 0));
  assert.equal(store.get("a", 0), null);
  assert.deepEqual(store.size(), { turns: 2, bytes: 64 });
});

test("reply audio stays under its byte budget, keeping the newest sentences", () => {
  const store = new JarvisAudioStore({ turns: 8, bytes: 1_000 });
  store.add(sentence("a", 0, 400));
  store.add(sentence("b", 0, 400));
  assert.deepEqual(store.size(), { turns: 2, bytes: 800 });
  store.add(sentence("b", 1, 400));
  assert.equal(store.get("a", 0), null, "the oldest reply went to make room");
  assert.deepEqual(store.size(), { turns: 1, bytes: 800 });
  // A reply too long for the budget lets its earliest sentences go.
  store.add(sentence("b", 2, 400));
  assert.equal(store.get("b", 0), null);
  assert.ok(store.get("b", 1) && store.get("b", 2));
  assert.deepEqual(store.size(), { turns: 1, bytes: 800 });
  // A sentence sent twice replaces the first copy.
  store.add(sentence("b", 2, 100));
  assert.deepEqual(store.size(), { turns: 1, bytes: 500 });
  store.clear();
  assert.deepEqual(store.size(), { turns: 0, bytes: 0 });
});

test("a companion reply keeps its turn in the feed, and its audio stays out of the state", () => {
  let id = 0;
  let state = initialJarvisState(licensed);
  const apply = (event, now = 1_000) => {
    const next = reduceJarvisEvent(state, event, () => ++id, now);
    if (next) state = next;
    return next;
  };
  apply({ t: "stt.final", text: "what's the weather?", source: "typed", turn: "t-1" });
  apply({ t: "tts.speaking", on: true, turn: "t-1" });
  apply({ t: "tts.text", text: "Sunny.", turn: "t-1" }, 2_000);
  assert.equal(apply(sentence("t-1", 0)), null, "audio never wakes state listeners");
  apply({ t: "tts.text", text: "High of 21.", turn: "t-1" }, 3_000);
  assert.equal(state.activity, "speaking");
  // Replies to different turns are different items, however close together.
  apply({ t: "tts.text", text: "Codex is done.", turn: "t-2" }, 4_000);
  apply({ t: "tts.text", text: "Also, Claude needs you." }, 5_000);
  assert.deepEqual(state.feed.map((item) => [item.kind, item.text, item.turn]), [
    ["asked", "what's the weather?", "t-1"],
    ["said", "Sunny. High of 21.", "t-1"],
    ["said", "Codex is done.", "t-2"],
    ["said", "Also, Claude needs you.", undefined],
  ]);
  assert.equal(JSON.stringify(state).includes("UklGR"), false, "no WAV in the state");
});

test("Jarvis's levels reach listeners throttled, only when they move, and settle on the latest", async () => {
  assert.equal(JARVIS_LEVEL_HZ, 15);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sent = [];
  const stream = new JarvisLevelStream((levels) => sent.push(levels), 20);
  stream.take({ t: "tts.level", level: 0.5 });
  assert.deepEqual(sent, [{ out: 0.5, mic: 0 }]);
  stream.take({ t: "vad.level", level: 0.3 });
  stream.take({ t: "tts.level", level: 0.61234 });
  assert.equal(sent.length, 1, "within 1/20 s of the last send");
  await sleep(90);
  assert.deepEqual(sent, [{ out: 0.5, mic: 0 }, { out: 0.612, mic: 0.3 }], "the latest goes out once the rate allows");
  await sleep(60);
  stream.take({ t: "tts.level", level: 0.62 });
  await sleep(90);
  assert.equal(sent.length, 2, "too small a move to send");
  stream.take({ t: "tts.level", level: 0 });
  assert.deepEqual(sent.at(-1), { out: 0, mic: 0.3 }, "falling silent always goes out");
  for (const ignored of [{ t: "tts.level", level: "loud" }, { t: "vad.level", level: Number.NaN }, { t: "system.level", level: 0.9 }, null]) stream.take(ignored);
  stream.take({ t: "vad.level", level: 7 });
  await sleep(90);
  assert.deepEqual(sent.at(-1), { out: 0, mic: 1 }, "clamped to 0..1");
  assert.equal(sent.length, 4);
  stream.reset();
  // Nobody listening: a pending send is dropped, and the next one starts afresh.
  const quiet = [];
  const dropped = new JarvisLevelStream((levels) => quiet.push(levels), 20);
  dropped.take({ t: "vad.level", level: 0.1 });
  dropped.take({ t: "vad.level", level: 0.2 });
  dropped.reset();
  await sleep(90);
  assert.deepEqual(quiet, [{ out: 0, mic: 0.1 }]);
  dropped.take({ t: "vad.level", level: 0.2 });
  assert.deepEqual(quiet, [{ out: 0, mic: 0.1 }, { out: 0, mic: 0.2 }]);
  dropped.reset();
});

/**
 * A stand-in Jarvis: its session.json in a temporary config dir, a UI bus (a
 * bare WebSocket server that only sends text frames) and the TCP control
 * endpoint, answering asks with `askReply`.
 */
async function fakeJarvis(t, { askReply = 'ok {"turn": "t-7"}' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-jarvis-live-"));
  const commands = [];
  const control = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line) => {
      const { command } = JSON.parse(line);
      commands.push(command);
      socket.end(command.startsWith("ask ") ? `${askReply}\n` : "ok on\n");
    });
  });
  const listeners = new Set();
  const bus = http.createServer();
  bus.on("upgrade", (request, socket) => {
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    listeners.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => listeners.delete(socket));
  });
  await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => bus.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.join(root, "jarvis"));
  fs.writeFileSync(path.join(root, "jarvis", "session.json"), JSON.stringify(session({
    bus: { url: `ws://127.0.0.1:${bus.address().port}`, token: "bus-token" },
    control: { endpoint: `tcp://127.0.0.1:${control.address().port}`, token: "c".repeat(64) },
  })));
  t.after(async () => {
    for (const socket of listeners) socket.destroy();
    await new Promise((resolve) => control.close(resolve));
    await new Promise((resolve) => bus.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    commands,
    /** Put one event on the bus, as Jarvis does. */
    publish(event) {
      const payload = Buffer.from(JSON.stringify(event));
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
      else if (payload.length < 65_536) header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
      else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      for (const socket of listeners) socket.write(Buffer.concat([header, payload]));
    },
  };
}

async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the bridge asks Jarvis for a companion reply and holds its audio for the phone", async (t) => {
  const jarvis = await fakeJarvis(t);
  const bridge = new JarvisBridge({ ...process.env, XDG_CONFIG_HOME: jarvis.root }, async () => licensed);
  t.after(() => bridge.stop());
  await bridge.start();
  await until(() => bridge.getState().connected, "the bus");
  const heard = [];
  const states = [];
  bridge.subscribeAudio((event) => heard.push(event));
  bridge.subscribe((state) => states.push(state));

  const asked = await bridge.ask("  what's the weather?  ", "remote", "companion");
  assert.equal(asked.turn, "t-7");
  assert.equal(asked.jarvis, bridge.getState());
  assert.equal(jarvis.commands.at(-1), `ask ${JSON.stringify({ text: "what's the weather?", from: "remote", reply: "companion" })}`);
  await bridge.ask("lights off", "athena");
  assert.deepEqual(JSON.parse(jarvis.commands.at(-1).slice(4)), { text: "lights off", from: "athena", reply: "local" });

  // Nobody is listening for levels yet: this one is dropped.
  jarvis.publish({ t: "tts.level", level: 0.5 });
  jarvis.publish({ t: "tts.text", text: "Sunny.", turn: "t-7" });
  jarvis.publish(sentence("t-7", 0, 70_000));
  jarvis.publish(sentence("t-7", 1));
  jarvis.publish(ending("t-7", 2));
  await until(() => heard.length === 3, "three audio events");
  assert.deepEqual(heard, [
    { turn: "t-7", seq: 0, final: false, interrupted: false },
    { turn: "t-7", seq: 1, final: false, interrupted: false },
    { turn: "t-7", seq: 2, final: true, interrupted: false },
  ]);
  assert.deepEqual(bridge.audioChunk("t-7", 0).wav, wav(70_000));
  assert.equal(bridge.audioChunk("t-7", 2), null);
  const levels = [];
  const stopLevels = bridge.subscribeLevels((value) => levels.push(value));
  jarvis.publish({ t: "vad.level", level: 0.25 });
  await until(() => levels.length === 1, "a level");
  assert.deepEqual(levels, [{ out: 0, mic: 0.25 }], "the voice level from before anyone listened was dropped");
  stopLevels();
  assert.equal(states.length, 1, "only the reply's text changed the state");
  assert.deepEqual(bridge.getState().feed.map((item) => [item.kind, item.text, item.turn]), [["said", "Sunny.", "t-7"]]);
});

test("an older Jarvis's ask names no turn", async (t) => {
  const jarvis = await fakeJarvis(t, { askReply: "ok asked" });
  const bridge = new JarvisBridge({ ...process.env, XDG_CONFIG_HOME: jarvis.root }, async () => licensed);
  t.after(() => bridge.stop());
  await bridge.start();
  assert.deepEqual(await bridge.ask("hello", "remote", "companion"), { jarvis: bridge.getState(), turn: null });
});

/** Read an event stream until `done(text so far)`. */
async function readStream(response, done) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

test("the control API asks for companion replies, streams their sentences and serves their audio", async (t) => {
  const jarvis = await fakeJarvis(t);
  // Only the license check is replaced: the rest is the real bridge the
  // control API uses, attached to the stand-in Jarvis.
  const bridge = jarvisBridge();
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = jarvis.root;
  bridge.readLicense = async () => licensed;
  const server = http.createServer(createControlRequestListener({ source: "remote", authorize: () => ({ ok: true }) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    bridge.stop();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await bridge.start();
  await until(() => bridge.getState().connected, "the bus");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/jarvis/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const refused = await post({ text: "hi", reply: "phone" });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'reply must be "local" or "companion"' });
  assert.equal(jarvis.commands.length, 0);
  const local = await (await post({ text: "lights off" })).json();
  assert.equal(local.turn, "t-7");
  assert.equal(local.jarvis.running, true);
  assert.equal(JSON.parse(jarvis.commands.at(-1).slice(4)).reply, "local", "the reply defaults to this computer");
  const asked = await post({ text: "what's the weather?", reply: "companion" });
  assert.equal(asked.status, 200);
  assert.equal((await asked.json()).turn, "t-7");
  assert.deepEqual(JSON.parse(jarvis.commands.at(-1).slice(4)), { text: "what's the weather?", from: "remote", reply: "companion" });

  const controller = new AbortController();
  // Answered once the stream has subscribed to the bridge.
  const events = await fetch(`${base}/jarvis/events`, { signal: controller.signal });
  t.after(() => controller.abort());
  const reading = readStream(events, (text) => text.includes('"final":true'));
  jarvis.publish({ t: "tts.level", level: 0.42 });
  jarvis.publish(sentence("t-7", 0, 5_000));
  jarvis.publish(ending("t-7", 1, true));
  const stream = await reading;
  assert.match(stream, /^event: jarvis\ndata: \{/);
  assert.match(stream, /event: jarvis-level\ndata: \{"out":0\.42,"mic":0\}\n\n/);
  assert.match(stream, /event: jarvis-audio\ndata: \{"turn":"t-7","seq":0,"final":false,"interrupted":false\}\n\n/);
  assert.match(stream, /event: jarvis-audio\ndata: \{"turn":"t-7","seq":1,"final":true,"interrupted":true\}\n\n/);
  assert.equal(stream.includes("UklGR"), false, "no audio in the stream");

  const audio = await fetch(`${base}/jarvis/audio/t-7/0`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
  assert.equal(audio.headers.get("cache-control"), "no-store");
  assert.equal(audio.headers.get("x-jarvis-sample-rate"), "24000");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav(5_000));
  for (const missing of ["/jarvis/audio/t-7/1", "/jarvis/audio/t-8/0", "/jarvis/audio/%E0%A4%A/0"]) {
    const response = await fetch(`${base}${missing}`);
    assert.equal(response.status, 404, missing);
    assert.match((await response.json()).error, /gone/);
  }
  assert.equal((await fetch(`${base}/jarvis/audio/t-7/x`)).status, 404);

  // Without the license the audio is refused like asking is.
  bridge.readLicense = async () => unlicensed;
  await bridge.refreshLicense();
  const locked = await fetch(`${base}/jarvis/audio/t-7/0`);
  assert.equal(locked.status, 403);
  assert.match((await locked.json()).error, /needs a license/);
  assert.equal((await post({ text: "hi", reply: "companion" })).status, 403);
});
