import assert from "node:assert/strict";
import test from "node:test";

import { normalizeExternalUrl } from "../dist-electron/external-links.js";

test("external URL opener allows http and https links", () => {
  assert.equal(normalizeExternalUrl("https://example.com/docs?q=athena"), "https://example.com/docs?q=athena");
  assert.equal(normalizeExternalUrl(" http://localhost:5173/path "), "http://localhost:5173/path");
});

test("external URL opener rejects local files and custom protocols", () => {
  assert.equal(normalizeExternalUrl("file:///etc/passwd"), null);
  assert.equal(normalizeExternalUrl("vscode://file/home/alan/project"), null);
  assert.equal(normalizeExternalUrl("javascript:alert(1)"), null);
});

test("external URL opener rejects malformed values", () => {
  assert.equal(normalizeExternalUrl("not a url"), null);
  assert.equal(normalizeExternalUrl(""), null);
});
