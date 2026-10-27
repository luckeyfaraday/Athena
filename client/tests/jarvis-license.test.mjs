import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { jarvisFingerprint, readJarvisLicense, verifyMachineFile } = await import("../dist-electron/jarvis-license.js");

// A throwaway Keygen account: tests sign machine files with their own key and
// hand the matching config to the verifier, exactly as Jarvis's tests do.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const config = {
  accountId: "acct-1",
  productId: "prod-1",
  policyId: "policy-1",
  publicKeyHex: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex"),
};
const NOW = Date.parse("2026-10-27T12:00:00Z") / 1000;
const FINGERPRINT = jarvisFingerprint("machine-guid-1");

function payload(overrides = {}) {
  const issued = new Date((NOW - 60) * 1000).toISOString();
  const expiry = new Date((NOW - 60 + 2592000) * 1000).toISOString();
  const license = {
    id: "lic-1",
    type: "licenses",
    attributes: { suspended: false, status: "ACTIVE", expiry: null, ...overrides.licenseAttributes },
    relationships: {
      account: { data: { type: "accounts", id: "acct-1" } },
      product: { data: { type: "products", id: "prod-1" } },
      policy: { data: { type: "policies", id: "policy-1" } },
      ...overrides.licenseRelationships,
    },
  };
  return {
    data: {
      id: "machine-1",
      type: "machines",
      attributes: { fingerprint: FINGERPRINT, ...overrides.machineAttributes },
      relationships: {
        account: { data: { type: "accounts", id: "acct-1" } },
        product: { data: { type: "products", id: "prod-1" } },
        license: { data: { type: "licenses", id: "lic-1" } },
        ...overrides.machineRelationships,
      },
    },
    included: overrides.included ?? [license],
    meta: { issued, expiry, ttl: 2592000, ...overrides.meta },
  };
}

function machineFile(body, { key = privateKey, alg = "base64+ed25519" } = {}) {
  const enc = Buffer.from(JSON.stringify(body)).toString("base64");
  const sig = crypto.sign(null, Buffer.from(`machine/${enc}`), key).toString("base64");
  const envelope = Buffer.from(JSON.stringify({ enc, sig, alg })).toString("base64");
  const lines = envelope.match(/.{1,64}/g).join("\n");
  return `-----BEGIN MACHINE FILE-----\n${lines}\n-----END MACHINE FILE-----\n`;
}

const verify = (certificate, fingerprint = FINGERPRINT, now = NOW) => verifyMachineFile(certificate, config, fingerprint, now);

test("a genuine machine file for this machine verifies", () => {
  const verified = verify(machineFile(payload()));
  assert.equal(verified.licenseId, "lic-1");
  assert.equal(verified.machineId, "machine-1");
  assert.equal(verified.expiresAt, NOW - 60 + 2592000);
});

test("the fingerprint matches Jarvis's sha256 of the prefixed machine id", () => {
  assert.equal(
    jarvisFingerprint("abc"),
    crypto.createHash("sha256").update("jarvis-ai:keygen:v1:abc").digest("hex"),
  );
});

test("a file signed by any other key is rejected", () => {
  const other = crypto.generateKeyPairSync("ed25519").privateKey;
  assert.throws(() => verify(machineFile(payload(), { key: other })), /signature is invalid/);
});

test("tampering with the signed payload breaks the signature", () => {
  const original = machineFile(payload());
  const body = original.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const envelope = JSON.parse(Buffer.from(body, "base64").toString());
  const forged = payload({ machineAttributes: { fingerprint: jarvisFingerprint("someone-else") } });
  envelope.enc = Buffer.from(JSON.stringify(forged)).toString("base64");
  const swapped = `-----BEGIN MACHINE FILE-----\n${Buffer.from(JSON.stringify(envelope)).toString("base64")}\n-----END MACHINE FILE-----`;
  assert.throws(() => verify(swapped, jarvisFingerprint("someone-else")), /signature is invalid/);
});

test("another machine's file, account, product or policy is rejected", () => {
  assert.throws(() => verify(machineFile(payload()), jarvisFingerprint("machine-guid-2")), /another machine/);
  assert.throws(
    () => verify(machineFile(payload({ machineRelationships: { account: { data: { type: "accounts", id: "acct-2" } } } }))),
    /another Keygen account/,
  );
  assert.throws(
    () => verify(machineFile(payload({ machineRelationships: { product: { data: { type: "products", id: "prod-2" } } } }))),
    /another product/,
  );
  assert.throws(
    () => verify(machineFile(payload({ licenseRelationships: { policy: { data: { type: "policies", id: "policy-2" } } } }))),
    /another policy/,
  );
});

test("expired, future-dated and overlong files are rejected", () => {
  assert.throws(() => verify(machineFile(payload()), FINGERPRINT, NOW + 2592000), /has expired/);
  const future = new Date((NOW + 3600) * 1000).toISOString();
  const futureExpiry = new Date((NOW + 3600 + 100) * 1000).toISOString();
  assert.throws(() => verify(machineFile(payload({ meta: { issued: future, expiry: futureExpiry, ttl: 100 } }))), /not valid yet/);
  assert.throws(() => verify(machineFile(payload({ meta: { ttl: 2592001 } }))), /unacceptable offline TTL/);
  assert.throws(() => verify(machineFile(payload({ meta: { ttl: 100 } }))), /TTL does not match/);
  // A few seconds of clock skew, as Keygen's own clock produces, is fine.
  const soon = new Date((NOW + 30) * 1000).toISOString();
  const soonExpiry = new Date((NOW + 30 + 2592000) * 1000).toISOString();
  assert.doesNotThrow(() => verify(machineFile(payload({ meta: { issued: soon, expiry: soonExpiry } }))));
});

test("suspended, disabled, unknown-status and expired licenses are rejected", () => {
  assert.throws(() => verify(machineFile(payload({ licenseAttributes: { suspended: true } }))), /suspended/);
  assert.throws(() => verify(machineFile(payload({ licenseAttributes: { status: "BANNED" } }))), /disabled license/);
  assert.throws(() => verify(machineFile(payload({ licenseAttributes: { status: "WHO-KNOWS" } }))), /unknown license status/);
  assert.throws(
    () => verify(machineFile(payload({ licenseAttributes: { expiry: "2026-01-01T00:00:00Z" } }))),
    /entitlement has expired/,
  );
  assert.doesNotThrow(() => verify(machineFile(payload({ licenseAttributes: { status: "INACTIVE", expiry: "2027-01-01T00:00:00.000Z" } }))));
  const noExpiry = payload();
  delete noExpiry.included[0].attributes.expiry;
  assert.throws(() => verify(machineFile(noExpiry)), /no expiry field/);
});

test("a file without its license, or with a foreign algorithm, is rejected", () => {
  assert.throws(() => verify(machineFile(payload({ included: [] }))), /does not include its license/);
  assert.throws(() => verify(machineFile(payload(), { alg: "aes-256-gcm+ed25519" })), /unsupported algorithm/);
  assert.throws(() => verify("not a machine file"), /not a Keygen machine file/);
  assert.throws(() => verify("-----BEGIN MACHINE FILE-----\n%%%%\n-----END MACHINE FILE-----"), /not valid base64/);
});

test("readJarvisLicense trusts only the certificate in license.json", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-jarvis-license-"));
  const env = { ...process.env, XDG_CONFIG_HOME: root };
  const file = path.join(root, "jarvis", "license.json");
  const read = () => readJarvisLicense({ env, nowMs: NOW * 1000, config, machineId: "machine-guid-1" });
  try {
    assert.deepEqual(
      { licensed: (await read()).licensed, detail: (await read()).detail },
      { licensed: false, detail: "Jarvis is not activated on this computer" },
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stored = { provider: "keygen", key: "ABCD-EFGH-1234-5678", status: "active", instance_name: "LAPTOP", certificate: null };
    fs.writeFileSync(file, JSON.stringify(stored));
    const legacy = await read();
    assert.equal(legacy.licensed, false, "a cache that merely says active is not evidence");
    assert.match(legacy.detail, /refresh/);
    fs.writeFileSync(file, JSON.stringify({ ...stored, certificate: machineFile(payload()) }));
    const licensed = await read();
    assert.equal(licensed.licensed, true);
    assert.equal(licensed.licenseId, "lic-1");
    assert.equal(licensed.keyMasked, "…234-5678");
    assert.equal(licensed.instanceName, "LAPTOP");
    assert.equal(licensed.offlineUntil, (NOW - 60 + 2592000) * 1000);
    const elsewhere = await readJarvisLicense({ env, nowMs: NOW * 1000, config, machineId: "machine-guid-2" });
    assert.equal(elsewhere.licensed, false, "a license.json copied from another computer does not count");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
