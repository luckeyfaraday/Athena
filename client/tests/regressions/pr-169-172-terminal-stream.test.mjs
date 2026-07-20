// Permanent incident coverage: bounded output/backpressure (#169) and the
// lost-ACK terminal wedge (#172). These suites exercise retained retries,
// duplicate/stale ACKs, independent consumers, explicit overflow resets, and
// VT/Unicode-safe bounded replay.
import "../terminal-buffer.test.mjs";
import "../terminal-output-ack.test.mjs";
