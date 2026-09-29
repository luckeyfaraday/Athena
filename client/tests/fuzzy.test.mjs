import assert from "node:assert/strict";
import test from "node:test";

import { fuzzyScore, queryWords, rankCommands } from "../src/fuzzy.ts";
import { parseRecents, pushRecent } from "../src/palette-recents.ts";

test("fuzzyScore returns null when the query is not a subsequence", () => {
  assert.equal(fuzzyScore("xyz", "New Shell"), null);
  assert.equal(fuzzyScore("shelll", "New Shell"), null);
  assert.equal(fuzzyScore("longer than text", "short"), null);
});

test("fuzzyScore treats an empty query as a neutral match", () => {
  assert.deepEqual(fuzzyScore("", "Anything"), { score: 0, indices: [] });
});

test("fuzzyScore is case-insensitive and reports the matched positions", () => {
  const match = fuzzyScore("NS", "new shell");
  assert.ok(match);
  assert.deepEqual(match.indices, [0, 4]);
  assert.deepEqual(fuzzyScore("ter", "Terminal")?.indices, [0, 1, 2]);
});

test("fuzzyScore prefers word starts over earlier mid-word letters", () => {
  // "s" and "h" also appear inside "Push"; the word-start "S" of "Shell" wins.
  assert.deepEqual(fuzzyScore("sh", "Push Shell")?.indices, [5, 6]);
  assert.deepEqual(fuzzyScore("cr", "Open Command Room")?.indices, [5, 13]);
});

test("a prefix match beats the same letters in the middle", () => {
  const prefix = fuzzyScore("ter", "Terminal");
  const middle = fuzzyScore("ter", "Enter");
  assert.ok(prefix && middle);
  assert.ok(prefix.score > middle.score);
});

test("a word-start match beats a mid-word match", () => {
  const wordStart = fuzzyScore("sh", "New Shell");
  const midWord = fuzzyScore("sh", "Push");
  assert.ok(wordStart && midWord);
  assert.ok(wordStart.score > midWord.score);
});

test("camelCase boundaries count as word starts", () => {
  const camel = fuzzyScore("r", "commandRoom");
  const plain = fuzzyScore("r", "corner");
  assert.ok(camel && plain);
  assert.ok(camel.score > plain.score);
});

test("a consecutive run beats scattered letters", () => {
  const run = fuzzyScore("abc", "abcxyz");
  const scattered = fuzzyScore("abc", "axbxcx");
  assert.ok(run && scattered);
  assert.ok(run.score > scattered.score);
});

test("an exact match beats a longer text with the same prefix", () => {
  const exact = fuzzyScore("codex", "Codex");
  const longer = fuzzyScore("codex", "Codex Grid");
  assert.ok(exact && longer);
  assert.ok(exact.score > longer.score);
});

test("queryWords splits and lowercases", () => {
  assert.deepEqual(queryWords("  New   SHELL "), ["new", "shell"]);
  assert.deepEqual(queryWords("   "), []);
});

const commands = [
  { id: "codex", title: "Launch Codex", group: "Launch", keywords: ["openai", "agent"] },
  { id: "shell", title: "New Shell", group: "Launch", keywords: ["terminal"] },
  { id: "codex-grid", title: "Launch Codex Grid", subtitle: "Four panes", group: "Launch" },
  { id: "theme-neon", title: "Theme: Neon", group: "Appearance", keywords: ["dark", "synthwave"] },
  { id: "theme-daylight", title: "Theme: Daylight", group: "Appearance", keywords: ["light"] },
  { id: "settings", title: "Open Settings", group: "Settings" },
];

test("rankCommands keeps the input order for an empty query", () => {
  const ranked = rankCommands("   ", commands);
  assert.deepEqual(ranked.map((item) => item.command.id), commands.map((command) => command.id));
  assert.ok(ranked.every((item) => item.score === 0 && item.titleIndices.length === 0));
});

test("rankCommands requires every word to match somewhere", () => {
  const ranked = rankCommands("new shell", commands);
  assert.deepEqual(ranked.map((item) => item.command.id), ["shell"]);
  assert.deepEqual(rankCommands("codex banana", commands), []);
});

test("rankCommands ranks the closest title first and highlights it", () => {
  const ranked = rankCommands("codex", commands);
  assert.equal(ranked[0].command.id, "codex");
  assert.equal(ranked[1].command.id, "codex-grid");
  assert.deepEqual(ranked[0].titleIndices, [7, 8, 9, 10, 11]);
});

test("rankCommands matches keywords, subtitles and groups", () => {
  assert.deepEqual(rankCommands("synthwave", commands).map((item) => item.command.id), ["theme-neon"]);
  assert.deepEqual(rankCommands("four panes", commands).map((item) => item.command.id), ["codex-grid"]);
  const appearance = rankCommands("appearance", commands).map((item) => item.command.id);
  assert.deepEqual(appearance, ["theme-neon", "theme-daylight"]);
});

test("rankCommands merges title highlights across words", () => {
  const [top] = rankCommands("theme day", commands);
  assert.equal(top.command.id, "theme-daylight");
  assert.deepEqual(top.titleIndices, [0, 1, 2, 3, 4, 7, 8, 9]);
});

test("rankCommands does not highlight the title for a keyword-only match", () => {
  const [top] = rankCommands("openai", commands);
  assert.equal(top.command.id, "codex");
  assert.deepEqual(top.titleIndices, []);
});

test("rankCommands keeps input order for equal scores and honors the limit", () => {
  const twins = [
    { id: "a", title: "Same" },
    { id: "b", title: "Same" },
    { id: "c", title: "Same" },
  ];
  assert.deepEqual(rankCommands("same", twins).map((item) => item.command.id), ["a", "b", "c"]);
  assert.deepEqual(rankCommands("same", twins, 2).map((item) => item.command.id), ["a", "b"]);
});

test("pushRecent moves an id to the front without duplicates and caps the list", () => {
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
  assert.deepEqual(pushRecent([], "a"), ["a"]);
});

test("parseRecents tolerates malformed storage", () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents("not json"), []);
  assert.deepEqual(parseRecents("{\"a\":1}"), []);
  assert.deepEqual(parseRecents("[\"a\", 3, \"b\"]"), ["a", "b"]);
});
