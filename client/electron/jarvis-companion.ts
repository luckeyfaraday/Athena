import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { jarvisConfigDir, readJarvisLicense, type JarvisLicenseState } from "./jarvis-license.js";

// Athena's link to a Jarvis voice session on this machine. A running Jarvis
// daemon publishes its UI bus and control endpoints in ~/.config/jarvis/session.json
// (user-only, removed on exit); Athena reads that, listens to the bus for what
// Jarvis hears, says and is doing, and sends it commands over the control
// channel. Nothing here works without a verified Jarvis license on this machine.
// One bridge serves the desktop renderer and every control API listener, so a
// phone reaching Athena over Tailscale gets the same Jarvis. No `electron` import.

export type JarvisSession = {
  pid: number;
  startedAt: string | null;
  jarvisVersion: string | null;
  bus: { url: string; token: string };
  control: { endpoint: string; token: string };
};

export type JarvisFeedItem = {
  id: number;
  at: number;
  kind: "heard" | "said" | "announce" | "agent" | "asked";
  text: string;
  agent?: string;
  /** The turn Jarvis gave a typed request and its reply, when it names one. */
  turn?: string;
};

export type JarvisAgent = {
  name: string;
  cwd: string | null;
  task: string | null;
  working: boolean;
  focused: boolean;
  status: string | null;
};

export type JarvisActivity = "idle" | "listening" | "thinking" | "speaking";

export type JarvisState = {
  license: JarvisLicenseState;
  installPath: string | null;
  /** A live daemon has published its session. */
  running: boolean;
  /** Athena is attached to that daemon's UI bus. */
  connected: boolean;
  micOpen: boolean | null;
  activity: JarvisActivity;
  /** What Jarvis is hearing right now, before the sentence is final. */
  partial: string | null;
  provider: string | null;
  model: string | null;
  agents: JarvisAgent[];
  feed: JarvisFeedItem[];
  lastError: string | null;
  updatedAt: number;
};

/**
 * Where Jarvis says its answer to an ask: out loud on its own computer
 * ("local"), or only as audio for the companion that asked ("companion"),
 * which Jarvis publishes on its bus sentence by sentence as tts.audio.
 */
export type JarvisReply = "local" | "companion";

/** An ask's answer: the state, and the turn of the reply (null from a Jarvis that predates turns). */
export type JarvisAskResult = { jarvis: JarvisState; turn: string | null };

/** A spoken reply sentence, held for /jarvis/audio. */
export type JarvisAudioChunk = { wav: Buffer; sampleRate: number };

/** A sentence (or the end of a reply) as announced to listeners: never the audio itself. */
export type JarvisAudioEvent = { turn: string; seq: number; final: boolean; interrupted: boolean };

export const JARVIS_FEED_LIMIT = 60;
// Reply audio waits here until the phone fetches it, which is within a second
// or two; a few recent replies are plenty, and a bound keeps memory flat.
export const JARVIS_AUDIO_TURNS = 8;
export const JARVIS_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const MAX_TURN_ID_CHARS = 128;
const MAX_AUDIO_SEQ = 100_000;
const MAX_FEED_TEXT = 4_000;
const SESSION_POLL_MS = 2_000;
const LICENSE_RECHECK_MS = 10 * 60_000;
const RECONNECT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONTROL_PROTOCOL_VERSION = 1;
const MAX_ASK_CHARS = 4_000;

export function jarvisSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(jarvisConfigDir(env), "session.json");
}

/**
 * Validate a session.json payload. Only loopback endpoints are accepted: the
 * file is user-only, but Athena still never sends Jarvis's tokens off-machine.
 */
export function parseJarvisSession(value: unknown): JarvisSession | null {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null;
  const bus = value.bus;
  const control = value.control;
  if (!isRecord(bus) || !isRecord(control)) return null;
  if (typeof bus.url !== "string" || typeof control.endpoint !== "string") return null;
  if (!isLoopbackUrl(bus.url, ["ws:"])) return null;
  const endpoint = control.endpoint;
  if (endpoint.startsWith("tcp://")) {
    if (!isLoopbackUrl(endpoint, ["tcp:"])) return null;
  } else if (!path.isAbsolute(endpoint)) {
    return null;
  }
  return {
    pid: value.pid as number,
    startedAt: typeof value.started_at === "string" ? value.started_at : null,
    jarvisVersion: typeof value.jarvis_version === "string" ? value.jarvis_version : null,
    bus: { url: bus.url, token: typeof bus.token === "string" ? bus.token : "" },
    control: { endpoint, token: typeof control.token === "string" ? control.token : "" },
  };
}

/** The published session, or null when there is none or its daemon has exited. */
export function readJarvisSession(env: NodeJS.ProcessEnv = process.env): JarvisSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(jarvisSessionPath(env), "utf8"));
  } catch {
    return null;
  }
  const session = parseJarvisSession(parsed);
  return session && processAlive(session.pid) ? session : null;
}

/** Bus URL with the session token, as Jarvis's bus expects it. */
export function jarvisBusUrl(session: JarvisSession): string {
  const url = new URL(session.bus.url);
  if (session.bus.token) url.searchParams.set("token", session.bus.token);
  return url.toString();
}

/**
 * Send one control command and return the payload of its "ok" reply. Windows
 * Jarvis listens on loopback TCP behind a versioned, token-carrying JSON line;
 * Unix Jarvis on a user-only socket that takes the bare command.
 */
export function jarvisControl(session: JarvisSession, command: string, timeoutMs = CONTROL_TIMEOUT_MS): Promise<string> {
  const endpoint = session.control.endpoint;
  let request: string;
  let connect: net.NetConnectOpts;
  if (endpoint.startsWith("tcp://")) {
    const url = new URL(endpoint);
    connect = { host: url.hostname, port: Number(url.port) };
    request = JSON.stringify({ version: CONTROL_PROTOCOL_VERSION, token: session.control.token, command });
  } else {
    connect = { path: endpoint };
    request = command.trim();
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connect);
    let data = "";
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Jarvis did not answer in time")));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${request}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_CONTROL_RESPONSE_BYTES) finish(new Error("Jarvis sent an oversized reply"));
      else if (data.includes("\n")) socket.end();
    });
    socket.on("error", (error) => finish(new Error(`Jarvis is not reachable: ${error.message}`)));
    socket.on("close", () => {
      const reply = data.split("\n")[0]?.trim() ?? "";
      if (reply.startsWith("ok")) finish(null, reply.slice(2).trim());
      else if (reply.startsWith("err ")) finish(new Error(reply.slice(4)));
      else finish(new Error("Jarvis closed the control connection without a reply"));
    });
  });
}

/** Where the Jarvis desktop app is installed, or null. Read-only probing. */
export function findJarvisInstall(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const candidates: string[] = [];
  if (platform === "win32") {
    for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(path.join(root, "Jarvis AI", "jarvis-hud.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push("/Applications/Jarvis AI.app");
    if (env.HOME) candidates.push(path.join(env.HOME, "Applications", "Jarvis AI.app"));
  } else {
    if (env.HOME) {
      candidates.push(path.join(env.HOME, "Applications", "Jarvis-AI.AppImage"), path.join(env.HOME, ".local", "bin", "jarvis-hud"));
    }
    candidates.push("/usr/bin/jarvis-hud", "/opt/Jarvis AI/jarvis-hud");
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const QUIET_EVENTS = new Set(["tts.level", "vad.level", "system.level", "gesture.state", "vision.look"]);

/**
 * Fold one bus event into the bridge state. Returns null when the event changes
 * nothing worth telling a listener (audio levels arrive many times a second).
 */
export function reduceJarvisEvent(state: JarvisState, event: unknown, nextId: () => number, now = Date.now()): JarvisState | null {
  if (!isRecord(event) || typeof event.t !== "string" || QUIET_EVENTS.has(event.t)) return null;
  const text = typeof event.text === "string" ? event.text.trim().slice(0, MAX_FEED_TEXT) : "";
  const on = event.on === true;
  const next = (patch: Partial<JarvisState>): JarvisState => ({ ...state, ...patch, updatedAt: now });
  switch (event.t) {
    case "stt.partial":
      return next({ partial: text || null });
    case "stt.final": {
      if (!text) return next({ partial: null });
      // Jarvis marks typed requests (from this panel or a phone) so the feed can
      // show them as typed rather than heard.
      const kind = event.source === "typed" ? "asked" : "heard";
      return next({ partial: null, feed: appendFeed(state.feed, { id: nextId(), at: now, kind, text, ...turnOf(event) }) });
    }
    case "tts.text": {
      if (!text) return null;
      // Jarvis streams a reply sentence by sentence; one reply is one feed item.
      // A reply that names its turn continues only that turn's item.
      const last = state.feed.at(-1);
      const turn = turnOf(event).turn;
      const sameReply = last?.kind === "said" && (turn || last.turn ? last.turn === turn : now - last.at < 30_000);
      if (last && sameReply) {
        const merged = { ...last, text: `${last.text} ${text}`.slice(0, MAX_FEED_TEXT) };
        return next({ feed: [...state.feed.slice(0, -1), merged] });
      }
      return next({ feed: appendFeed(state.feed, { id: nextId(), at: now, kind: "said", text, ...turnOf(event) }) });
    }
    case "announce":
      return text ? next({ feed: appendFeed(state.feed, { id: nextId(), at: now, kind: "announce", text }) }) : null;
    case "agent.event": {
      const agent = typeof event.agent === "string" ? event.agent : "an agent";
      const kind = typeof event.kind === "string" ? event.kind : "event";
      const message = typeof event.message === "string" ? event.message.trim() : "";
      const line = `${kind}${message ? `: ${message}` : ""}`.slice(0, MAX_FEED_TEXT);
      return next({ feed: appendFeed(state.feed, { id: nextId(), at: now, kind: "agent", text: line, agent }) });
    }
    case "user.speaking":
      return next({ activity: on ? "listening" : state.activity === "listening" ? "idle" : state.activity });
    case "jarvis.thinking":
      return next({ activity: on ? "thinking" : state.activity === "thinking" ? "idle" : state.activity });
    case "tts.speaking":
      return next({ activity: on ? "speaking" : state.activity === "speaking" ? "idle" : state.activity });
    case "mic.state":
      return typeof event.open === "boolean" ? next({ micOpen: event.open }) : null;
    case "session.info":
      return next({
        provider: typeof event.provider === "string" ? event.provider : null,
        model: typeof event.model === "string" ? event.model : null,
      });
    case "agent.roster":
      return Array.isArray(event.agents) ? next({ agents: event.agents.map(rosterEntry).filter((agent) => agent !== null) }) : null;
    default:
      return null;
  }
}

/** The turn a newer Jarvis gives an ask (`ok {"turn": "<id>"}`); null from one that answers `ok asked`. */
export function jarvisAskTurn(reply: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return null;
  }
  return isRecord(value) ? (turnOf(value).turn ?? null) : null;
}

type AudioTurn = { chunks: Map<number, JarvisAudioChunk>; done: boolean };

/**
 * The audio of replies Jarvis kept off its own speakers for a companion
 * (a phone), until the companion fetches it. Bounded by turns and bytes: the
 * oldest reply goes first, and a reply too long for the budget on its own
 * lets its earliest sentences go, which the companion fetched as they came.
 * A reply ends with its final marker; anything later for it is ignored.
 */
export class JarvisAudioStore {
  private readonly turns = new Map<string, AudioTurn>();
  private bytes = 0;

  constructor(private readonly limits = { turns: JARVIS_AUDIO_TURNS, bytes: JARVIS_AUDIO_MAX_BYTES }) {}

  /** Take one tts.audio bus event. Returns what to announce, or null for a malformed or late one. */
  add(event: unknown): JarvisAudioEvent | null {
    if (!isRecord(event) || event.t !== "tts.audio") return null;
    const { turn: id } = turnOf(event);
    const seq = event.seq;
    if (!id || !Number.isSafeInteger(seq) || (seq as number) < 0 || (seq as number) > MAX_AUDIO_SEQ) return null;
    const announced: JarvisAudioEvent = { turn: id, seq: seq as number, final: event.final === true, interrupted: event.interrupted === true };
    const existing = this.turns.get(id);
    if (existing?.done) return null;
    if (announced.final) {
      this.turnFor(id, existing).done = true;
      this.trim(id);
      return announced;
    }
    const wav = decodeWav(event);
    if (!wav) return null;
    const turn = this.turnFor(id, existing);
    this.bytes -= turn.chunks.get(announced.seq)?.wav.length ?? 0;
    turn.chunks.set(announced.seq, { wav, sampleRate: event.sample_rate as number });
    this.bytes += wav.length;
    this.trim(id);
    return announced;
  }

  get(turn: string, seq: number): JarvisAudioChunk | null {
    return this.turns.get(turn)?.chunks.get(seq) ?? null;
  }

  /** Held turns and bytes, for tests and diagnostics. */
  size(): { turns: number; bytes: number } {
    return { turns: this.turns.size, bytes: this.bytes };
  }

  clear(): void {
    this.turns.clear();
    this.bytes = 0;
  }

  private turnFor(id: string, existing: AudioTurn | undefined): AudioTurn {
    if (existing) return existing;
    const turn: AudioTurn = { chunks: new Map(), done: false };
    this.turns.set(id, turn);
    return turn;
  }

  private trim(keep: string): void {
    for (const [id, turn] of this.turns) {
      if (this.turns.size <= this.limits.turns && this.bytes <= this.limits.bytes) return;
      if (id === keep) continue;
      this.turns.delete(id);
      for (const chunk of turn.chunks.values()) this.bytes -= chunk.wav.length;
    }
    const current = this.turns.get(keep);
    if (!current) return;
    for (const [seq, chunk] of current.chunks) {
      if (this.bytes <= this.limits.bytes) return;
      current.chunks.delete(seq);
      this.bytes -= chunk.wav.length;
    }
  }
}

// A tts.audio sentence's WAV bytes, or null unless it is one.
function decodeWav(event: Record<string, unknown>): Buffer | null {
  if (event.format !== "wav" || typeof event.data !== "string") return null;
  if (!Number.isSafeInteger(event.sample_rate) || (event.sample_rate as number) <= 0) return null;
  const wav = Buffer.from(event.data, "base64");
  return wav.length > 12 && wav.toString("latin1", 0, 4) === "RIFF" && wav.toString("latin1", 8, 12) === "WAVE" ? wav : null;
}

/** An Athena pane (here or on another machine) that finished or needs the user. */
export type JarvisAlert = {
  /** Tailnet machine name; null for this computer. */
  machine: string | null;
  agentKind: string;
  title: string;
  workspace: string | null;
  terminalId: string;
  kind: "action" | "update";
  reason: string;
  message: string | null;
};

/**
 * The control-channel event Jarvis announces for an alert: "codex on omarchy
 * is done", "claude in athena needs you". Shells and housekeeping (bells,
 * exits, OSC notifications) stay quiet; Athena's own toasts cover those.
 */
export function jarvisAlertEvent(alert: JarvisAlert): Record<string, unknown> | null {
  if (!alert.agentKind || alert.agentKind === "shell") return null;
  const type = alert.reason === "turn-complete" ? "stop" : alert.kind === "action" ? "notification" : null;
  if (!type) return null;
  // Split on both separators: the folder name must not depend on which OS
  // reads a Windows or POSIX workspace path.
  const folder = alert.workspace?.split(/[\\/]+/).filter(Boolean).at(-1);
  const where = alert.machine ? ` on ${alert.machine}` : folder ? ` in ${folder}` : "";
  return {
    type,
    source: "athena",
    agent: `${alert.agentKind}${where}`,
    message: alert.message ?? "",
    machine: alert.machine,
    terminal_id: alert.terminalId,
    cwd: alert.workspace ?? "",
  };
}

export function initialJarvisState(license: JarvisLicenseState): JarvisState {
  return {
    license,
    installPath: null,
    running: false,
    connected: false,
    micOpen: null,
    activity: "idle",
    partial: null,
    provider: null,
    model: null,
    agents: [],
    feed: [],
    lastError: null,
    updatedAt: Date.now(),
  };
}

type Listener = (state: JarvisState) => void;
type AudioListener = (event: JarvisAudioEvent) => void;

/**
 * The live link. `start` begins watching for a session (cheap: one small file
 * read every couple of seconds) and only opens the bus once the license checks
 * out. Listeners get a fresh state on every meaningful change; audio listeners
 * hear about each reply sentence Jarvis spoke for a companion, which stays out
 * of the state and is fetched with `audioChunk`.
 */
export class JarvisBridge {
  private state: JarvisState;
  private readonly listeners = new Set<Listener>();
  private readonly audioListeners = new Set<AudioListener>();
  private readonly audio = new JarvisAudioStore();
  private session: JarvisSession | null = null;
  private socket: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectAt = 0;
  private licenseCheckedAt = 0;
  private feedId = 0;
  private started = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly readLicense: (env: NodeJS.ProcessEnv) => Promise<JarvisLicenseState> = (env) => readJarvisLicense({ env }),
  ) {
    this.state = initialJarvisState({ licensed: false, detail: "checking the Jarvis license", offlineUntil: null, licenseId: null, keyMasked: null, instanceName: null });
  }

  getState(): JarvisState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeAudio(listener: AudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  /** One sentence of a companion reply while it is still held; null once evicted or never seen. */
  audioChunk(turn: string, seq: number): JarvisAudioChunk | null {
    this.requireLicense();
    return this.audio.get(turn, seq);
  }

  async start(): Promise<JarvisState> {
    if (!this.started) {
      this.started = true;
      this.pollTimer = setInterval(() => void this.tick(), SESSION_POLL_MS);
      this.pollTimer.unref?.();
    }
    await this.refreshLicense();
    await this.tick();
    return this.state;
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.closeSocket();
  }

  async refreshLicense(): Promise<JarvisState> {
    const license = await this.readLicense(this.env);
    this.licenseCheckedAt = Date.now();
    this.update({ license, installPath: findJarvisInstall(this.env) });
    if (!license.licensed) this.closeSocket();
    return this.state;
  }

  /** "mic on" | "mic off" | "mic toggle"; resolves with the mic's new state. */
  async setMic(command: "on" | "off" | "toggle"): Promise<JarvisState> {
    const reply = await jarvisControl(this.requireSession(), `mic ${command}`);
    this.update({ micOpen: reply === "on" });
    return this.state;
  }

  /**
   * Hand Jarvis a typed request as if it had been spoken: from the Athena panel
   * or a phone. The reply's text arrives on the bus like any other; a
   * "companion" reply is not spoken on this computer but sent as tts.audio for
   * the asker to play. A Jarvis that predates replies ignores `reply`, speaks
   * aloud, and names no turn.
   */
  async ask(text: string, from: string, reply: JarvisReply = "local"): Promise<JarvisAskResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("say something for Jarvis to do");
    if (trimmed.length > MAX_ASK_CHARS) throw new Error(`keep requests under ${MAX_ASK_CHARS} characters`);
    // The request comes back on the bus as a typed stt.final, which is what
    // puts it in the feed; adding it here too would show it twice.
    const answer = await jarvisControl(this.requireSession(), `ask ${JSON.stringify({ text: trimmed, from, reply })}`);
    return { jarvis: this.state, turn: jarvisAskTurn(answer) };
  }

  /** Tell Jarvis an Athena agent finished or needs the user, so it can say so. Best effort. */
  relayAlert(alert: JarvisAlert): void {
    const event = jarvisAlertEvent(alert);
    if (!event || !this.session || !this.state.license.licensed) return;
    void jarvisControl(this.session, `event ${JSON.stringify(event)}`).catch(() => undefined);
  }

  /** Open the Jarvis desktop app, which starts its own licensed daemon. */
  launch(): JarvisState {
    this.requireLicense();
    if (this.state.running) return this.state;
    const install = findJarvisInstall(this.env);
    if (!install) throw new Error("Jarvis is not installed on this computer");
    const child = process.platform === "darwin"
      ? spawn("open", ["-a", install], { detached: true, stdio: "ignore" })
      : spawn(install, [], { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(install) });
    child.on("error", (error) => this.update({ lastError: `could not open Jarvis: ${error.message}` }));
    child.unref();
    this.update({ installPath: install, lastError: null });
    return this.state;
  }

  private requireLicense(): void {
    if (!this.state.license.licensed) throw new Error(`Jarvis needs a license on this computer (${this.state.license.detail ?? "not activated"})`);
  }

  private requireSession(): JarvisSession {
    this.requireLicense();
    if (!this.session) throw new Error("Jarvis is not running");
    return this.session;
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.licenseCheckedAt > LICENSE_RECHECK_MS) await this.refreshLicense();
    const session = readJarvisSession(this.env);
    const changed = !sameSession(session, this.session);
    if (changed) {
      this.closeSocket();
      // Another Jarvis may number its turns afresh.
      this.audio.clear();
      this.session = session;
      this.update({ running: session !== null, connected: false, activity: "idle", partial: null, ...(session ? {} : { micOpen: null, agents: [] }) });
    }
    if (this.session && this.state.license.licensed && !this.socket && Date.now() >= this.reconnectAt) this.connect(this.session);
  }

  private connect(session: JarvisSession): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(jarvisBusUrl(session));
    } catch (error) {
      this.update({ lastError: `could not reach the Jarvis bus: ${String(error)}` });
      this.reconnectAt = Date.now() + RECONNECT_MS;
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (this.socket === socket) this.update({ connected: true, lastError: null });
    });
    socket.addEventListener("message", (message) => {
      if (this.socket !== socket || typeof message.data !== "string") return; // binary frames are camera previews
      let event: unknown;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (isRecord(event) && event.t === "tts.audio") {
        // A companion reply's sentence: held for /jarvis/audio, never in the state.
        const announced = this.audio.add(event);
        if (announced) this.emitAudio(announced);
        return;
      }
      const next = reduceJarvisEvent(this.state, event, () => ++this.feedId);
      if (next) this.emit(next);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.reconnectAt = Date.now() + RECONNECT_MS;
      this.update({ connected: false });
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.update({ lastError: "the Jarvis bus refused or dropped the connection" });
    });
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (this.state.connected) this.update({ connected: false });
    }
  }

  private update(patch: Partial<JarvisState>): void {
    this.emit({ ...this.state, ...patch, updatedAt: Date.now() });
  }

  private emit(next: JarvisState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // one broken listener must not starve the others
      }
    }
  }

  private emitAudio(event: JarvisAudioEvent): void {
    for (const listener of this.audioListeners) {
      try {
        listener(event);
      } catch {
        // as for state listeners
      }
    }
  }
}

let bridge: JarvisBridge | null = null;

/** The process-wide bridge shared by IPC and the control API. */
export function jarvisBridge(): JarvisBridge {
  bridge ??= new JarvisBridge();
  return bridge;
}

function appendFeed(feed: JarvisFeedItem[], item: JarvisFeedItem): JarvisFeedItem[] {
  return [...feed, item].slice(-JARVIS_FEED_LIMIT);
}

// The turn an event names, spread into a feed item only when it has one.
function turnOf(event: Record<string, unknown>): { turn?: string } {
  const turn = event.turn;
  return typeof turn === "string" && turn && turn.length <= MAX_TURN_ID_CHARS ? { turn } : {};
}

function rosterEntry(value: unknown): JarvisAgent | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  return {
    name: value.name,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    task: typeof value.task === "string" && value.task ? value.task : null,
    working: value.working === true,
    focused: value.focused === true,
    status: typeof value.status === "string" ? value.status : null,
  };
}

function sameSession(a: JarvisSession | null, b: JarvisSession | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.bus.url === b.bus.url && a.bus.token === b.bus.token && a.control.endpoint === b.control.endpoint && a.control.token === b.control.token;
}

function isLoopbackUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port !== "";
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just owned by someone else - not ours, but not stale either.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
