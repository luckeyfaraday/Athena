// Native, project-scoped durable memory for athena-code.
//
// This is the in-process equivalent of Hermes's MEMORY.md store. It has no
// dependency on opencode internals or on the Athena HTTP backend, so the hot
// path (read on snapshot build, append on memory_write) is a local file read,
// never a network round-trip. The Effect/opencode service wrapper and the
// memory_write tool are thin glue layered on top of these functions.

import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface MemoryEntry {
  id: string
  text: string
  created_at: string
  hash: string
  source: string
}

const MEMORY_SUBDIR = join(".context-workspace", "memory")
const ENTRIES_FILE = "entries.jsonl"

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

export function randomHex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString("hex")
    .slice(0, chars)
}

// Head+tail truncation with a visible marker, mirroring the backend's budgeting
// so a native snapshot renders identically to the legacy one.
export function bounded(value: string, maxChars: number): { text: string; truncated: boolean } {
  const text = value.trim()
  if (text.length <= maxChars) return { text, truncated: false }
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  const marker = "\n\n[...truncated by Athena immersive context budget...]\n\n"
  return {
    text: `${text.slice(0, head).trimEnd()}${marker}${text.slice(text.length - tail).trimStart()}`,
    truncated: true,
  }
}

export function memoryDir(workspace: string): string {
  return join(resolve(workspace), MEMORY_SUBDIR)
}

export function readMemoryEntries(workspace: string): MemoryEntry[] {
  const file = join(memoryDir(workspace), ENTRIES_FILE)
  if (!existsSync(file)) return []
  const out: MemoryEntry[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as MemoryEntry)
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return out
}

// Append a durable memory. Returns null when the text is empty or a byte-identical
// entry already exists (dedup), matching Hermes's deduplicated memory frozen at
// session start.
export function appendMemory(workspace: string, text: string, source = "agent"): MemoryEntry | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const hash = sha256(trimmed)
  if (readMemoryEntries(workspace).some((entry) => entry.hash === hash)) return null
  const entry: MemoryEntry = { id: `mem_${randomHex(24)}`, text: trimmed, created_at: nowIso(), hash, source }
  const dir = memoryDir(workspace)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, ENTRIES_FILE), JSON.stringify(entry) + "\n", "utf8")
  return entry
}

export function renderMemory(workspace: string, maxChars: number): { text: string; truncated: boolean } {
  const body = readMemoryEntries(workspace)
    .map((entry) => `- ${entry.text}`)
    .join("\n")
  return bounded(body, maxChars)
}
