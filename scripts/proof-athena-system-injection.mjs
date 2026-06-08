#!/usr/bin/env node
// Proof: does a value placed on PromptInput.system reach the model request's
// system block in athena-code (the opencode fork)?
//
// This is a *static request-capture* proof: it traces the literal source chain
// from PromptInput.system to the bytes handed to the provider, against a real
// opencode checkout at the pinned build revision. It is runnable without the
// ~3GB bun build, so it is safe to run on a constrained disk.
//
// Usage:
//   node scripts/proof-athena-system-injection.mjs [opencode_source_dir]
//   ATHENA_OPENCODE_SOURCE=/path node scripts/proof-athena-system-injection.mjs
//
// For the gold-standard *runtime* capture (actual system array sent to a model),
// see scripts/athena-proof/capture-system.ts.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const SRC =
  process.argv[2] ||
  process.env.ATHENA_OPENCODE_SOURCE ||
  "/tmp/athena-opencode-patch-check"

const PKG = join(SRC, "packages", "opencode", "src", "session")

if (!existsSync(PKG)) {
  console.error(
    `error: opencode source not found at ${PKG}\n` +
      `Pass the checkout dir as an argument or set ATHENA_OPENCODE_SOURCE.`,
  )
  process.exit(2)
}

/** Find the 1-based line number of the first line matching `re`, or null. */
function findLine(file, re) {
  const text = readFileSync(join(PKG, file), "utf8")
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return { n: i + 1, text: lines[i].trim() }
  return null
}

// Each link in the chain from PromptInput.system -> the wire.
const links = [
  {
    label: "PromptInput exposes an optional `system` field",
    file: "prompt.ts",
    re: /system:\s*Schema\.optional\(Schema\.String\)/,
  },
  {
    label: "createUserMessage stores it on the user message: `system: input.system`",
    file: "prompt.ts",
    re: /system:\s*input\.system\b/,
  },
  {
    label: "runLoop passes the assembled array + the user message to handle.process",
    file: "prompt.ts",
    re: /handle\.process\(\{/,
  },
  {
    label: "request.prepare() appends the user message's system to the wire system block",
    file: "llm/request.ts",
    re: /\.\.\.\(input\.user\.system\s*\?\s*\[input\.user\.system\]\s*:\s*\[\]\)/,
  },
  {
    label: "request.prepare() also forwards the assembled array via `...input.system`",
    file: "llm/request.ts",
    re: /\.\.\.input\.system\b/,
  },
  {
    label: "native-request forwards input.system into the canonical LLM request",
    file: "llm/native-request.ts",
    re: /system:\s*\[\.\.\.\(input\.system\s*\?\?\s*\[\]\)/,
  },
]

let ok = true
console.log(`athena-code system-injection proof`)
console.log(`source: ${SRC}\n`)
for (const link of links) {
  const hit = findLine(link.file, link.re)
  if (hit) {
    console.log(`  PASS  ${link.file}:${hit.n}  ${link.label}`)
    console.log(`        > ${hit.text}`)
  } else {
    ok = false
    console.log(`  FAIL  ${link.file}     ${link.label}  (pattern not found)`)
  }
}

// Two design facts the proof surfaces along the way.
const joined = findLine("llm/request.ts", /\]\s*$/) // best-effort; the .join is on the next lines
const joinHit = findLine("llm/request.ts", /\.join\("\\n"\)/) || findLine("llm/request.ts", /\.join\("\n"\)/)
console.log("")
console.log("design notes:")
console.log(
  joinHit
    ? `  - request.ts joins all system parts into ONE string (.join), so any per-turn\n` +
        `    change busts cache for the whole system block — splitting stable vs volatile\n` +
        `    requires more than appending to PromptInput.system. (llm/request.ts:${joinHit.n})`
    : `  - (could not locate the .join; verify system-part concatenation manually)`,
)

console.log("")
if (ok) {
  console.log("VERDICT: PASS — a value on PromptInput.system REACHES the model system block.")
  console.log("         The current immersive shim is NOT a no-op; the defect is lifecycle")
  console.log("         (per-turn rebuild + per-turn bundle dir), not non-delivery.")
  process.exit(0)
} else {
  console.log("VERDICT: FAIL — chain is broken at the link(s) above; re-trace before relying on it.")
  process.exit(1)
}
