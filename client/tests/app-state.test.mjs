import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyLoadState,
  sameAgentMessages,
  sameAgentSessions,
  sameBackendStatus,
  sameElectronControlStatus,
  sameJsonValue,
  sameLoadState,
  samePerformanceDiagnostics,
  sameStringArray,
} from "../src/app-state.ts";

test("sameStringArray preserves state only for identical ordered strings", () => {
  assert.equal(sameStringArray(["a", "b"], ["a", "b"]), true);
  assert.equal(sameStringArray(["a", "b"], ["b", "a"]), false);
  assert.equal(sameStringArray(["a"], ["a", "b"]), false);
});

test("sameJsonValue detects structural equality for plain IPC/API payloads", () => {
  assert.equal(sameJsonValue({ running: true, port: 5173 }, { running: true, port: 5173 }), true);
  assert.equal(sameJsonValue({ running: true, port: 5173 }, { running: false, port: 5173 }), false);
});

test("status comparators keep no-op health checks from replacing state", () => {
  const backend = { baseUrl: "http://127.0.0.1:1", healthy: true, running: true, port: 1, lastError: null };
  const control = { baseUrl: "http://127.0.0.1:2", running: true, port: 2, lastError: null };

  assert.equal(sameBackendStatus(backend, { ...backend }), true);
  assert.equal(sameBackendStatus(backend, { ...backend, healthy: false }), false);
  assert.equal(sameElectronControlStatus(control, { ...control }), true);
  assert.equal(sameElectronControlStatus(control, { ...control, lastError: "failed" }), false);
});

test("sameAgentSessions compares large session lists without serializing the whole array", () => {
  const session = {
    id: "session-1",
    provider: "codex",
    title: "Codex Builder",
    workspace: "/workspace",
    branch: "main",
    model: "gpt-5",
    agent: null,
    createdAt: "2026-06-28T15:00:00Z",
    updatedAt: "2026-06-28T15:01:00Z",
    status: "running",
    terminalId: "terminal-1",
    pid: 123,
    resumeCommand: "codex resume session-1",
    metadata: { source: "test" },
  };

  assert.equal(sameAgentSessions([session], [structuredClone(session)]), true);
  assert.equal(sameAgentSessions([session], [{ ...session, title: "Renamed" }]), false);
  assert.equal(sameAgentSessions([session], [{ ...session, metadata: { source: "changed" } }]), false);
});

test("sameAgentMessages preserves unchanged swarm inbox state", () => {
  const message = {
    id: "message-1",
    threadId: "thread-1",
    at: "2026-06-28T15:00:00Z",
    updatedAt: "2026-06-28T15:00:01Z",
    workspace: "/workspace",
    from: "human",
    fromTerminalId: "terminal-1",
    to: "codex#1",
    toTerminalId: "terminal-2",
    toKind: "codex",
    text: "please review",
    preview: "please review",
    status: "queued",
    replyRequested: true,
    hopCount: 0,
    source: "ui",
    error: null,
  };

  assert.equal(sameAgentMessages([message], [structuredClone(message)]), true);
  assert.equal(sameAgentMessages([message], [{ ...message, status: "delivered" }]), false);
  assert.equal(sameAgentMessages([message], []), false);
});

test("samePerformanceDiagnostics preserves unchanged diagnostics state", () => {
  const diagnostics = {
    activeTerminals: 2,
    bufferedTerminalChars: 1024,
    pendingOutputBytes: 0,
    maxBufferChars: 200_000,
    ptyChunksPerSecond: 1.5,
    ptyBytesPerSecond: 256,
    ipcBatchesPerSecond: 1,
    ipcBytesPerSecond: 128,
    eventLoopLagMs: 4,
    maxEventLoopLagMs: 11,
    lastOutputBatchAt: "2026-06-28T15:00:00Z",
    controlEvents: [{
      id: "event-1",
      at: "2026-06-28T15:00:00Z",
      kind: "spawn.succeeded",
      source: "ui",
      terminalId: "terminal-1",
      terminalTitle: "Codex",
      terminalKind: "codex",
      detail: "ok",
      preview: null,
    }],
    terminalControl: [{
      terminalId: "terminal-1",
      title: "Codex",
      kind: "codex",
      workspace: "/workspace",
      pid: 123,
      status: "running",
      lastSpawnAt: "2026-06-28T15:00:00Z",
      spawnSource: "ui",
      lastSpawnResult: "ok",
      lastInjectedAt: null,
      lastInjectedBy: null,
      lastInjectTextPreview: null,
      lastInjectResult: null,
      lastPtyWriteAt: "2026-06-28T15:00:01Z",
      lastOutputAt: "2026-06-28T15:00:02Z",
      attentionReason: null,
    }],
    agentProcesses: [{
      pid: 123,
      ppid: 12,
      agent: "codex",
      command: "codex",
      managedTerminalId: "terminal-1",
      managedTerminalTitle: "Codex",
      workspace: "/workspace",
    }],
  };

  assert.equal(samePerformanceDiagnostics(diagnostics, structuredClone(diagnostics)), true);
  assert.equal(samePerformanceDiagnostics(null, diagnostics), false);
  assert.equal(samePerformanceDiagnostics(diagnostics, null), false);
  assert.equal(samePerformanceDiagnostics(diagnostics, { ...diagnostics, pendingOutputBytes: 64 }), false);
  assert.equal(samePerformanceDiagnostics(diagnostics, {
    ...diagnostics,
    terminalControl: [{ ...diagnostics.terminalControl[0], attentionReason: "approval" }],
  }), false);
});

test("sameLoadState keeps no-op refreshes from replacing app state", () => {
  const current = {
    ...emptyLoadState,
    hermes: {
      installed: true,
      command_path: "/usr/local/bin/hermes",
      version: "1.0.0",
      hermes_home: "/tmp/hermes",
      config_exists: true,
      memory_path: "/tmp/memory.jsonl",
      native_windows: false,
      install_supported: true,
      setup_required: false,
      message: "ok",
    },
    recall: {
      project_dir: "/workspace",
      exists: true,
      status: "fresh",
      stale: false,
      path: "/tmp/recall.md",
      metadata_path: "/tmp/recall.json",
      bytes: 123,
      refreshed_at: "2026-06-28T15:00:00Z",
      age_seconds: 60,
      stale_after_seconds: 3600,
      source: "test",
      source_count: 2,
      source_titles: ["A", "B"],
      schema_version: 2,
      handoff_id: "handoff-1",
      confidence: "high",
      source_workspaces: ["/workspace"],
      source_sessions: [],
      used_for_launch_at: null,
      last_launch_agent: null,
      refresh_configured: true,
    },
    adapters: {
      codex: { name: "codex", available: true, detail: "ready" },
    },
    memory: ["one", "two"],
  };

  assert.equal(sameLoadState(current, structuredClone(current)), true);
  assert.equal(sameLoadState(current, { ...current, memory: ["one", "changed"] }), false);
  assert.equal(sameLoadState(current, { ...current, adapters: { ...current.adapters, codex: { ...current.adapters.codex, available: false } } }), false);
});
