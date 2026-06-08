import { test, expect } from "bun:test"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMemory, bounded, readMemoryEntries } from "../overlay/packages/opencode/src/session/memory/store"
import {
  clearSnapshotCache,
  createSnapshot,
  frozenSnapshot,
  frozenSnapshotSystem,
} from "../overlay/packages/opencode/src/session/memory/snapshot"

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("memory dedups byte-identical entries", () => {
  const ws = workspace("athmem-")
  expect(appendMemory(ws, "alpha fact")).not.toBeNull()
  expect(appendMemory(ws, "alpha fact")).toBeNull()
  expect(appendMemory(ws, "beta fact")).not.toBeNull()
  expect(readMemoryEntries(ws).length).toBe(2)
})

test("bounded truncates with a visible marker and respects the budget", () => {
  const long = "x".repeat(5000)
  const { text, truncated } = bounded(long, 1000)
  expect(truncated).toBe(true)
  expect(text).toContain("truncated by Athena")
  expect(text.length).toBeLessThan(long.length)
})

test("snapshot sources are deterministic for identical inputs", () => {
  const ws = workspace("athsnap-")
  appendMemory(ws, "durable fact one")
  writeFileSync(join(ws, "CLAUDE.md"), "project rules", "utf8")
  const a = createSnapshot(ws, { agent: "ATHENA CODE" })
  const b = createSnapshot(ws, { agent: "ATHENA CODE" })
  expect(a.bundle_id).not.toBe(b.bundle_id)
  expect(a.sources.map((s) => s.sha256)).toEqual(b.sources.map((s) => s.sha256))
})

test("frozenSnapshot builds once per session and freezes against later writes", () => {
  clearSnapshotCache()
  const ws = workspace("athfreeze-")
  appendMemory(ws, "fact before snapshot")
  const first = frozenSnapshot(ws, "sess-1")
  appendMemory(ws, "fact added after snapshot") // live write during the session
  const second = frozenSnapshot(ws, "sess-1")

  expect(second.bundle_id).toBe(first.bundle_id) // same frozen snapshot
  expect(readdirSync(join(ws, ".context-workspace", "context")).length).toBe(1) // one dir, no leak

  const memory = first.sources.find((s) => s.kind === "hermes_memory")
  expect(memory?.content).toContain("fact before snapshot")
  expect(memory?.content).not.toContain("fact added after snapshot")
})

test("frozenSnapshotSystem returns a stable, cached, fenced system entry", () => {
  clearSnapshotCache()
  const ws = workspace("athsys-")
  appendMemory(ws, "fact for system entry")
  const first = frozenSnapshotSystem(ws, "sess-sys")
  appendMemory(ws, "later fact") // live write after the entry was built
  const second = frozenSnapshotSystem(ws, "sess-sys")

  expect(second).toBe(first) // cached, byte-identical across turns
  expect(first).toContain("<athena-immersive-context")
  expect(first).toContain("fact for system entry")
  expect(first).not.toContain("later fact") // frozen
  expect(readdirSync(join(ws, ".context-workspace", "context")).length).toBe(1)
})

test("a new session picks up memory written after the prior snapshot", () => {
  clearSnapshotCache()
  const ws = workspace("athnew-")
  appendMemory(ws, "original fact")
  frozenSnapshot(ws, "sess-A")
  appendMemory(ws, "new fact for next session")
  const next = frozenSnapshot(ws, "sess-B")

  const memory = next.sources.find((s) => s.kind === "hermes_memory")
  expect(memory?.content).toContain("new fact for next session")
  expect(readdirSync(join(ws, ".context-workspace", "context")).length).toBe(2)
})
