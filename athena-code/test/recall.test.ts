import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMemory } from "../overlay/packages/opencode/src/session/memory/store"
import {
  clearRecallCache,
  recallSystemEntry,
  recallText,
  scoreMemory,
} from "../overlay/packages/opencode/src/session/memory/recall"

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("scoreMemory ranks query-relevant entries and ignores the rest", () => {
  const entries = [
    { id: "1", text: "the deploy pipeline uses bun to build athena-code", created_at: "2026-06-01T00:00:00Z", hash: "a", source: "agent" },
    { id: "2", text: "favorite color is teal", created_at: "2026-06-02T00:00:00Z", hash: "b", source: "agent" },
    { id: "3", text: "athena-code build runs the smoke test after bundling", created_at: "2026-06-03T00:00:00Z", hash: "c", source: "agent" },
  ]
  const scored = scoreMemory("how does the athena-code build work", entries)
  const ids = scored.map((s) => s.entry.id)
  expect(ids).toContain("1")
  expect(ids).toContain("3")
  expect(ids).not.toContain("2") // no token overlap
  expect(scored.every((s) => s.score > 0 && s.score <= 1)).toBe(true)
})

test("empty / stopword-only query returns nothing", () => {
  const entries = [{ id: "1", text: "athena memory", created_at: "2026-06-01T00:00:00Z", hash: "a", source: "agent" }]
  expect(scoreMemory("", entries)).toEqual([])
  expect(scoreMemory("the and for with", entries)).toEqual([])
})

test("recallText surfaces the relevant entry out of many", () => {
  const ws = workspace("athrecall-")
  appendMemory(ws, "the staging database password rotates every monday")
  appendMemory(ws, "lunch is usually around noon")
  appendMemory(ws, "the api gateway times out after thirty seconds")
  const text = recallText(ws, "why does the gateway api time out")
  expect(text).toContain("gateway")
  expect(text).not.toContain("lunch")
})

test("recallSystemEntry fences, memoizes, and is frozen against later writes within a turn", () => {
  clearRecallCache()
  const ws = workspace("athrecallsys-")
  appendMemory(ws, "the migration script must run before the deploy step")
  const first = recallSystemEntry(ws, "what order do migration and deploy run in")
  appendMemory(ws, "the migration step also seeds demo data") // written after first recall
  const second = recallSystemEntry(ws, "what order do migration and deploy run in")

  expect(second).toBe(first) // memoized by query, stable across a turn's steps
  expect(first).toContain("<athena-recall")
  expect(first).toContain("migration script")
  expect(first).not.toContain("seeds demo data") // not re-scored mid-turn
})

test("recallSystemEntry returns empty when nothing is relevant", () => {
  clearRecallCache()
  const ws = workspace("athrecallempty-")
  appendMemory(ws, "the build uses bun")
  expect(recallSystemEntry(ws, "completely unrelated astronomy question")).toBe("")
})
