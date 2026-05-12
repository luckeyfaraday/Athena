import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  listEmbeddedTerminals,
  spawnEmbeddedTerminal,
  type EmbeddedTerminalKind,
  type EmbeddedTerminalSession,
} from "./embedded-terminal.js";

type ControlState = {
  baseUrl: string | null;
  port: number | null;
  running: boolean;
  lastError: string | null;
};

type SpawnTerminalRequest = {
  project_dir?: string;
  workspace?: string;
  kind?: string;
  count?: number;
  title?: string;
  resume_session_id?: string;
  session_label?: string;
  cols?: number;
  rows?: number;
};

const SUPPORTED_TERMINAL_KINDS = new Set<EmbeddedTerminalKind>(["shell", "hermes", "codex", "opencode", "claude"]);
const MAX_TERMINAL_SPAWN_COUNT = 8;

let server: http.Server | null = null;
let state: ControlState = {
  baseUrl: null,
  port: null,
  running: false,
  lastError: null,
};

export async function startControlServer(): Promise<ControlState> {
  if (server && state.baseUrl) return { ...state };

  const port = await findFreePort();
  const nextServer = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    nextServer.once("error", reject);
    nextServer.listen(port, "127.0.0.1", resolve);
  });

  server = nextServer;
  state = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    running: true,
    lastError: null,
  };
  writeControlDiscovery();
  return { ...state };
}

export async function stopControlServer(): Promise<void> {
  const serverToStop = server;
  server = null;
  if (!serverToStop) {
    state = { ...state, running: false };
    writeControlDiscovery();
    return;
  }
  await new Promise<void>((resolve) => serverToStop.close(() => resolve()));
  state = { ...state, running: false };
  writeControlDiscovery();
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "electron-control" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/terminals") {
      sendJson(response, 200, { terminals: listEmbeddedTerminals() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/terminals/spawn") {
      const payload = parseSpawnTerminalRequest(await readJsonBody(request));
      const sessions: EmbeddedTerminalSession[] = [];
      for (let index = 0; index < payload.count; index += 1) {
        sessions.push(
          await spawnEmbeddedTerminal(payload.workspace, {
            kind: payload.kind,
            title: payload.count > 1 ? terminalGridTitle(payload.kind, index) : payload.title,
            cols: payload.cols,
            rows: payload.rows,
            resumeSessionId: payload.resumeSessionId,
            sessionLabel: payload.sessionLabel,
          }),
        );
        if (payload.kind === "opencode" && index < payload.count - 1) await delay(650);
      }
      sendJson(response, 200, { sessions });
      return;
    }
    sendJson(response, 404, { error: `Unknown control endpoint: ${request.method} ${url.pathname}` });
  } catch (error) {
    state = { ...state, lastError: String(error) };
    writeControlDiscovery();
    sendJson(response, 400, { error: String(error) });
  }
}

function parseSpawnTerminalRequest(body: unknown): {
  workspace: string;
  kind: EmbeddedTerminalKind;
  count: number;
  title?: string;
  resumeSessionId?: string;
  sessionLabel?: string;
  cols?: number;
  rows?: number;
} {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object.");
  const request = body as SpawnTerminalRequest;
  const workspace = String(request.project_dir ?? request.workspace ?? "").trim();
  if (!workspace) throw new Error("project_dir is required.");
  const kind = String(request.kind ?? "shell").trim().toLowerCase();
  if (!SUPPORTED_TERMINAL_KINDS.has(kind as EmbeddedTerminalKind)) {
    throw new Error(`Unsupported terminal kind: ${request.kind}`);
  }
  const rawCount = Number(request.count ?? 1);
  const count = Math.max(1, Math.min(Number.isFinite(rawCount) ? Math.floor(rawCount) : 1, MAX_TERMINAL_SPAWN_COUNT));
  return {
    workspace,
    kind: kind as EmbeddedTerminalKind,
    count,
    title: stringValue(request.title),
    resumeSessionId: stringValue(request.resume_session_id),
    sessionLabel: stringValue(request.session_label),
    cols: numberValue(request.cols),
    rows: numberValue(request.rows),
  };
}

function terminalGridTitle(kind: EmbeddedTerminalKind, index: number): string {
  const titles = kind === "codex"
    ? ["Codex Builder", "Codex Reviewer", "Codex Scout", "Codex Fixer"]
    : kind === "opencode"
      ? ["OpenCode Builder", "OpenCode Reviewer", "OpenCode Scout", "OpenCode Fixer"]
      : kind === "claude"
        ? ["Claude Builder", "Claude Reviewer", "Claude Scout", "Claude Fixer"]
        : [];
  return titles[index] ?? `${kind}-${index + 1}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : undefined;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 64_000) {
        request.destroy(new Error("Request body is too large."));
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Unable to allocate Electron control port.")));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeControlDiscovery(): void {
  try {
    const directory = path.join(os.homedir(), ".context-workspace");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "electron-control.json"),
      JSON.stringify(
        {
          baseUrl: state.baseUrl,
          port: state.port,
          pid: process.pid,
          running: state.running,
          lastError: state.lastError,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Discovery is best-effort; the in-app control server remains authoritative.
  }
}
