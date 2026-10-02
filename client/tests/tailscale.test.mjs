import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A fake `tailscale` CLI first on PATH stands in for the real client. It logs
// each invocation so the tests can check caching.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-fake-tailscale-"));
const log = path.join(dir, "calls.log");
const script = path.join(dir, "tailscale");
fs.writeFileSync(script, `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  status) cat <<'EOF'
{"BackendState":"Running","User":{"42":{"ID":42,"LoginName":"alan@example.com"}},
 "Self":{"ID":"nSELF","UserID":42,"HostName":"omarchy","DNSName":"omarchy.tail1234.ts.net.","OS":"linux","Online":true,"TailscaleIPs":["100.101.102.103"]},
 "Peer":{"k":{"ID":"nLAPTOP","UserID":42,"HostName":"surface","DNSName":"surface.tail1234.ts.net.","OS":"linux","Online":true,"TailscaleIPs":["100.124.147.99"]}}}
EOF
  ;;
  whois)
    if [ "$3" = "100.124.147.99" ]; then
      echo '{"Node":{"StableID":"nLAPTOP","ComputedName":"surface","User":42},"UserProfile":{"ID":42,"LoginName":"alan@example.com"}}'
    else
      echo "no match for IP:port" >&2; exit 1
    fi
  ;;
esac
`, { mode: 0o755 });

const skip = process.platform === "win32" ? "fake CLI is a POSIX shell script" : false;
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
const { cachedTailscaleStatus, tailscaleIdentity, tailscalePeerName, tailscaleStatus } = await import("../dist-electron/tailscale.js");

function calls() {
  try {
    return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("tailscaleStatus reads and caches the status", { skip }, async () => {
  assert.equal(cachedTailscaleStatus(), null);
  const [first, second] = await Promise.all([tailscaleStatus(), tailscaleStatus()]);
  assert.equal(first, second);
  assert.equal(first.self.loginName, "alan@example.com");
  assert.equal(first.peers[0].hostName, "surface");
  assert.equal(calls().filter((call) => call.startsWith("status")).length, 1, "concurrent reads share one CLI call");
  await tailscaleStatus();
  assert.equal(calls().filter((call) => call.startsWith("status")).length, 1, "a fresh read is reused");
  await tailscaleStatus({ maxAgeMs: 0 });
  assert.equal(calls().filter((call) => call.startsWith("status")).length, 2, "maxAgeMs 0 forces a new read");
  assert.equal(cachedTailscaleStatus().hostName, "omarchy");
  assert.equal(tailscalePeerName("100.124.147.99"), "surface");
  assert.equal(tailscalePeerName("::ffff:100.101.102.103"), "omarchy");
  assert.equal(tailscalePeerName("100.64.0.9"), null);
});

test("tailscaleIdentity caches answers and failures per address", { skip }, async () => {
  const identity = await tailscaleIdentity("::ffff:100.124.147.99");
  assert.equal(identity.loginName, "alan@example.com");
  assert.equal(identity.nodeId, "nLAPTOP");
  assert.equal(await tailscaleIdentity("100.124.147.99"), identity, "cached by normalized address");
  assert.equal(calls().filter((call) => call.startsWith("whois")).length, 1);
  assert.equal(await tailscaleIdentity("100.64.0.9"), null);
  assert.equal(await tailscaleIdentity("100.64.0.9"), null);
  assert.equal(calls().filter((call) => call === "whois --json 100.64.0.9").length, 1, "failures are cached briefly too");
});
