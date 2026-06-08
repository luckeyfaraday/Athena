// Gold-standard *runtime* request-capture for athena-code (opencode fork).
//
// This is a native opencode plugin (no fork patch required). It hooks
// `experimental.chat.system.transform`, which fires inside llm/request.ts on the
// exact `system: string[]` about to be sent to the provider — the same array the
// static proof (scripts/proof-athena-system-injection.mjs) traces. Use it to
// confirm, against a live model turn, that immersive context actually lands in
// the wire system block.
//
// Install (in a built athena-code / opencode):
//   1. Copy this file somewhere on disk, e.g. ~/.config/opencode/plugin/capture-system.ts
//      (or reference it via the `plugin` array in opencode config).
//   2. Optionally set a marker to assert on:
//        export ATHENA_PROOF_MARKER='Athena Immersive Context'
//      and an output path (defaults to ./.athena-system-capture.jsonl):
//        export ATHENA_PROOF_OUT=/tmp/athena-system-capture.jsonl
//   3. Run an immersive turn (ATHENA_IMMERSIVE_MODE=1). Each model call appends
//      one JSON line: the full system array, its char length, and whether the
//      marker was present.
//
// Inspect:
//   tail -n1 /tmp/athena-system-capture.jsonl | jq '{present, chars, sessionID}'

import { appendFile } from "node:fs/promises"
import type { Plugin } from "@opencode-ai/plugin"

const OUT = process.env.ATHENA_PROOF_OUT?.trim() || "./.athena-system-capture.jsonl"
const MARKER = process.env.ATHENA_PROOF_MARKER?.trim() || "Athena Immersive Context"

export const AthenaSystemCapture: Plugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    const joined = output.system.join("\n")
    const record = {
      at: new Date().toISOString(),
      sessionID: input.sessionID ?? null,
      model: `${input.model?.providerID ?? "?"}/${input.model?.modelID ?? input.model?.id ?? "?"}`,
      parts: output.system.length,
      chars: joined.length,
      marker: MARKER,
      // The whole point: is the immersive content actually in the wire system?
      present: joined.includes(MARKER),
      system: output.system,
    }
    await appendFile(OUT, JSON.stringify(record) + "\n", "utf8").catch(() => {})
    // Non-destructive: we only observe, never mutate `output.system`.
  },
})

export default AthenaSystemCapture
