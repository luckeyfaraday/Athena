import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatTranscriptParser,
  MAX_CHAT_BLOCKS,
  normalizeTerminalText,
  parseChatTranscript,
  stripAnsi,
} from "../src/chat-parse.ts";
import {
  CHAT_STREAM_ANCHOR_CHARS,
  chatStreamEndForBuffer,
  recordChatPromptForSession,
  updateChatStreamAnchor,
} from "../src/chat-mode.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\x5c";
const TITLE = "Codex";

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "the", "patch", "fixes", "server", "config", "status", "tests", "pass", "Starting", "build", "state",
  "render", "chat", "output", "error", "value", "hi", "MCP", "working", "done", "file", "src/app.ts", "12",
];

function makeGenerator(random) {
  const int = (max) => Math.floor(random() * max);
  const pick = (list) => list[int(list.length)];
  const word = () => pick(WORDS);
  const sentence = () => Array.from({ length: 2 + int(10) }, word).join(" ");
  const fragments = [
    () => `${sentence()}\r\n`,
    () => `${sentence()}\r\n`,
    () => `${sentence()}\n`,
    () => `${ESC}[3${int(8)}m${sentence()}${ESC}[0m\r\n`,
    () => `${ESC}[${1 + int(40)};${1 + int(80)}H`,
    () => `${ESC}[2K\r⠋ Working (${int(60)}s • esc to interrupt)`,
    () => `\r${ESC}[K✻ Thinking… (${int(9)}s)`,
    () => `${ESC}]0;${word()}${BEL}`,
    () => `${ESC}]8;;https://example.com/${word()}${ST}${word()}${ESC}]8;;${ST}`,
    () => `${ESC}7`,
    () => `${ESC}8`,
    () => `${ESC}(B`,
    () => `${ESC}[?2026h`,
    () => `${ESC}[?2026l`,
    () => `${ESC}[${int(5)}A`,
    () => "\r\n",
    () => "\n",
    () => "\r",
    () => "\r\r\n",
    () => `╭${"─".repeat(20)}╮\r\n│ ${sentence()} │\r\n╰${"─".repeat(20)}╯\r\n`,
    () => "Available Tools\r\n  read_file\r\n  write_file\r\nWelcome to Hermes Agent\r\n",
    () => "You are running inside an embedded Context Workspace terminal.\r\nAgent: codex\r\nPane: 1\r\nReady.\r\n",
    () => `error: ${sentence()} failed\r\n`,
    () => `› ${sentence()}\r\n`,
    () => `${"lorem ipsum dolor sit amet ".repeat(int(160))}\r\n`,
    () => "⠋ thinking...\r\n",
    () => `\x9b1;31m${word()}\x9b0m`,
    () => `${ESC}[12;\n`,
    () => `${ESC}]0;unterminated ${word()}\n`,
    () => "\x00\x07\x7f",
    () => "Starting MCP servers (3/5) server ok\r\n",
    () => `${word()}\t${word()}\r\n`,
    () => `[12;3H${word()}[2K`,
    () => "  \r\n",
    () => `${"=".repeat(int(20))}\r\n`,
    () => `model: gpt-5 ${word()}\r\n`,
    () => `${ESC}${ESC}[1m${word()}${ESC}[0m`,
  ];
  return {
    int,
    stream(length) {
      let out = "";
      while (out.length < length) out += pick(fragments)();
      return out;
    },
    chunks(text) {
      const chunks = [];
      let offset = 0;
      while (offset < text.length) {
        const size = random() < 0.3 ? 1 + int(4) : 1 + int(random() < 0.5 ? 64 : 700);
        chunks.push(text.slice(offset, offset + size));
        offset += size;
      }
      return chunks;
    },
  };
}

function prompt(text, marker, index) {
  return { id: `prompt-${index}`, role: "user", label: "You", text, marker };
}

test("incremental parsing matches a full parse for random streams and chunk boundaries", () => {
  const random = mulberry32(0xc0ffee);
  const generator = makeGenerator(random);
  let comparisons = 0;
  for (let round = 0; round < 40; round++) {
    const text = generator.stream(2_000 + generator.int(24_000));
    const parser = new ChatTranscriptParser();
    let prompts = round % 3 === 0 ? [prompt("fix the build", 0, 0)] : [];
    let fed = "";
    for (const chunk of generator.chunks(text)) {
      parser.append(chunk);
      fed += chunk;
      if (random() < 0.03) {
        // A new prompt at the current end, or (like broadcasts) slightly in the
        // past, but never before the previous prompt.
        const room = parser.position - (prompts.at(-1)?.marker ?? 0);
        const back = random() < 0.4 ? generator.int(Math.min(room, 3_000) + 1) : 0;
        prompts = [...prompts.slice(-4), prompt(`task ${prompts.length}`, parser.position - back, round * 100 + prompts.length)];
        if (random() < 0.8) parser.setMarkers(prompts.map((block) => block.marker));
      }
      if (random() < 0.04) {
        assert.deepEqual(parser.view(prompts, TITLE), parseChatTranscript(fed, prompts, TITLE), `round ${round} at ${fed.length}`);
        comparisons++;
      }
    }
    assert.equal(parser.position, text.length);
    assert.deepEqual(parser.view(prompts, TITLE), parseChatTranscript(text, prompts, TITLE), `round ${round} final`);
    comparisons++;
  }
  assert.ok(comparisons > 80);
});

test("incremental parsing matches a full parse on long streams with trimmed history", () => {
  const random = mulberry32(42);
  const generator = makeGenerator(random);
  for (let round = 0; round < 4; round++) {
    const text = generator.stream(150_000 + generator.int(60_000));
    // A small raw window exercises raw/line trimming and checkpoint pruning.
    const parser = new ChatTranscriptParser({ rawRetainChars: round % 2 ? 2_000 : 32_000 });
    let prompts = [];
    let fed = "";
    for (const chunk of generator.chunks(text)) {
      parser.append(chunk);
      fed += chunk;
      if (random() < 0.002) {
        prompts = [...prompts.slice(-4), prompt(`long task ${round}`, parser.position, prompts.length)];
        // The component applies new markers right away (layout effect -> view).
        parser.setMarkers(prompts.map((block) => block.marker));
      }
    }
    assert.deepEqual(parser.view(prompts, TITLE), parseChatTranscript(text, prompts, TITLE), `round ${round}`);
    assert.ok(parser.view(prompts, TITLE).length > 0);
  }
});

test("prompt history rollover keeps segments aligned with the right prompts", () => {
  const random = mulberry32(7);
  const generator = makeGenerator(random);
  const sessionId = `rollover-${Date.now()}`;
  const parser = new ChatTranscriptParser();
  let prompts = [];
  let fed = "";
  for (let turn = 0; turn < 8; turn++) {
    prompts = recordChatPromptForSession(sessionId, `question ${turn}`, parser.position);
    const reply = `answer ${turn}: ${generator.stream(600)}\r\n`;
    for (const chunk of generator.chunks(reply)) parser.append(chunk);
    fed += reply;
    assert.deepEqual(parser.view(prompts, TITLE), parseChatTranscript(fed, prompts, TITLE), `turn ${turn}`);
  }
  assert.equal(prompts.length, 8);
});

test("reset parses the snapshot window from scratch", () => {
  const random = mulberry32(99);
  const generator = makeGenerator(random);
  const snapshot = generator.stream(120_000);
  const parser = new ChatTranscriptParser();
  parser.append("stale output that must disappear\r\n");
  const prompts = [prompt("initial task", 0, 0), prompt("follow up", 100_000, 1)];
  parser.reset(snapshot, prompts.map((block) => block.marker));
  assert.equal(parser.position, snapshot.length);
  // Only the last 80KB is parsed: same as a full parse of that window with
  // markers shifted into it (prompt bubbles are the original objects).
  const from = snapshot.length - 80_000;
  const shifted = prompts.map((block) => ({ ...block, marker: block.marker - from }));
  const unshift = (blocks) => blocks.map((block) => prompts[shifted.indexOf(block)] ?? block);
  const expected = unshift(parseChatTranscript(snapshot.slice(from), shifted, TITLE));
  assert.deepEqual(parser.view(prompts, TITLE), expected);
  assert.ok(expected.length > 2);

  const tail = generator.stream(5_000);
  parser.append(tail);
  const expectedAfter = unshift(parseChatTranscript(snapshot.slice(from) + tail, shifted, TITLE));
  assert.deepEqual(parser.view(prompts, TITLE), expectedAfter);
});

test("view returns the same array while only transient chrome redraws", () => {
  const parser = new ChatTranscriptParser();
  const prompts = [prompt("explain the diff", 0, 0)];
  parser.append("The diff renames the parser and adds tests.\r\n");
  const first = parser.view(prompts, TITLE);
  assert.equal(first.length, 2);
  for (let second = 1; second < 50; second++) {
    parser.append(`${ESC}[2K\r⠙ Working (${second}s • esc to interrupt)${ESC}[1A`);
    assert.equal(parser.view(prompts, TITLE), first);
  }
  parser.append("\r\nIt also documents the flush cadence.\r\n");
  const next = parser.view(prompts, TITLE);
  assert.notEqual(next, first);
  assert.match(next.at(-1).text, /flush cadence/);
});

test("a prompt marker whose raw text was trimmed starts the next turn now", () => {
  const parser = new ChatTranscriptParser({ rawRetainChars: 100 });
  // Longer than the retained raw window plus its trimming slack.
  parser.append(`${"first answer line\r\n".repeat(2_000)}`);
  const prompts = [prompt("second question", 10, 0)];
  const before = parser.view(prompts, TITLE);
  assert.equal(before.at(-1), prompts[0]);
  parser.append("second answer\r\n");
  const after = parser.view(prompts, TITLE);
  assert.equal(after.at(-2), prompts[0]);
  assert.equal(after.at(-1).text, "second answer");
});

test("skip keeps absolute positions and recovers at the next line", () => {
  const parser = new ChatTranscriptParser();
  parser.append(`kept answer\r\npartial ${ESC}[31`);
  parser.skip(1_000);
  assert.equal(parser.position, "kept answer\r\npartial \x1b[31".length + 1_000);
  parser.append("m tail of dropped line\r\nfresh line\r\n");
  const texts = parser.view([], TITLE).map((block) => block.text).join("\n");
  assert.match(texts, /kept answer/);
  assert.match(texts, /fresh line/);
  assert.doesNotMatch(texts, /partial/);
});

test("stripAnsi removes sequences without eating surrounding text", () => {
  assert.equal(stripAnsi(`${ESC}[1;31mred${ESC}[0m plain`), "red plain");
  assert.equal(stripAnsi(`a${ESC}]0;window title${BEL}b`), "ab");
  // ST-terminated OSC 8 hyperlinks keep their link text.
  assert.equal(stripAnsi(`see ${ESC}]8;;https://x.test${ST}docs${ESC}]8;;${ST} now`), "see docs now");
  // DECSC/DECRC, charset designation, DECALN, C1 CSI.
  assert.equal(stripAnsi(`a${ESC}7b${ESC}8c${ESC}(Bd${ESC}#8e\x9b1mf`), "abcdef");
  assert.equal(stripAnsi(`x${ESC}${ESC}[1my`), "xy");
  // Controls other than tab/CR/LF are dropped.
  assert.equal(stripAnsi("a\x00b\x07c\x7fd\te\r\n"), "abcd\te\r\n");
  // Malformed sequences surface their parameters, as the legacy regexes did.
  assert.equal(stripAnsi(`x${ESC}[12;\ny`), "x12;\ny");
  assert.equal(stripAnsi(`x${ESC}]0;unterminated\ny`), "x0;unterminated\ny");
  // A sequence that is still arriving is hidden rather than flashed.
  assert.equal(stripAnsi(`done${ESC}[38;5`), "done");
});

test("chunk boundaries inside escape sequences do not change the transcript", () => {
  const text = `${ESC}[38;5;208mhello${ESC}[0m ${ESC}]8;;https://a.test${ST}link${ESC}]8;;${ST}\r\r\nnext${ESC}(B line\r\nlast`;
  const expected = parseChatTranscript(text, [], TITLE);
  for (let split = 1; split < text.length; split++) {
    const parser = new ChatTranscriptParser();
    parser.append(text.slice(0, split));
    parser.append(text.slice(split));
    assert.deepEqual(parser.view([], TITLE), expected, `split at ${split}`);
  }
});

test("chat filters hide chrome, echo and noise but keep assistant text", () => {
  const transcript = normalizeTerminalText([
    "Available Tools",
    "  read_file",
    "Welcome to Hermes Agent",
    "│ The fix is in src/app.ts │",
    "╭──────────────────────╮",
    "⠋ thinking...",
    "Working (4s • esc to interrupt)",
    "Starting MCP servers: server one, server two",
    "",
    "",
    "Tests pass now.",
  ].join("\r\n"));
  // The startup panel is skipped through its closing "Welcome" line.
  assert.equal(transcript, "The fix is in src/app.ts\n\nTests pass now.");

  const blocks = parseChatTranscript(
    ["› run the tests", "error: 2 tests failed", "Both failures are in the parser.", "[process exited: 1]"].join("\r\n"),
    [prompt("run the tests", 0, 0)],
    TITLE,
  );
  assert.deepEqual(blocks.map((block) => [block.role, block.text]), [
    ["user", "run the tests"],
    ["status", "error: 2 tests failed"],
    ["status", "[process exited: 1]"],
    ["assistant", "Both failures are in the parser."],
  ]);
});

test("long assistant output is split into bounded bubbles and capped", () => {
  const line = "This sentence is part of a long assistant answer that keeps going.";
  const text = Array.from({ length: 400 }, (_, index) => `${index}: ${line}`).join("\r\n");
  const blocks = parseChatTranscript(text, [], TITLE);
  assert.ok(blocks.length > 1 && blocks.length <= MAX_CHAT_BLOCKS);
  assert.ok(blocks.every((block) => block.text.length <= 2600));
  assert.match(blocks.at(-1).text, /399: This sentence/);
});

// Mirrors EmbeddedChatTerminal: attach maps the snapshot into the session's
// stream coordinates; every flush re-anchors the session.
function mountChatView(sessionId, snapshot, prompts) {
  const parser = new ChatTranscriptParser();
  const end = chatStreamEndForBuffer(sessionId, snapshot);
  parser.reset(snapshot, prompts.map((block) => block.marker), end - snapshot.length);
  return parser;
}

function flushChatView(sessionId, parser, text) {
  parser.append(text);
  updateChatStreamAnchor(sessionId, parser.position, parser.recentRaw(CHAT_STREAM_ANCHOR_CHARS));
}

test("replies after a prompt survive a remount on a long stream", () => {
  const sessionId = `remount-${Date.now()}`;
  const BACKEND_CHARS = 40_000;
  let stream = "";
  const parser = mountChatView(sessionId, "", []);
  let line = 0;
  while (stream.length < 290_000) {
    let chunk = "";
    for (let k = 0; k < 40; k++) chunk += `${ESC}[3${line % 7}mbuild step ${++line} finished${ESC}[0m\r\n`;
    flushChatView(sessionId, parser, chunk);
    stream += chunk;
  }
  const prompts = recordChatPromptForSession(sessionId, "why did the build slow down", parser.position);
  const reply = "The cache key changed.\r\nRebuilding once fixes it.\r\n";
  flushChatView(sessionId, parser, reply);
  stream += reply;
  const before = parser.view(prompts, TITLE);
  assert.equal(before.at(-2), prompts.at(-1));
  assert.match(before.at(-1).text, /Rebuilding once fixes it\./);

  // Workspace tab switch: the pane unmounts, then re-attaches to a snapshot
  // of the main-process buffer, which only keeps the tail of the stream.
  const remounted = mountChatView(sessionId, stream.slice(-BACKEND_CHARS), prompts);
  assert.deepEqual(remounted.view(prompts, TITLE), before);

  // Output that arrived while unmounted still lands after the prompt.
  stream += "Verified with a clean build.\r\n";
  const later = mountChatView(sessionId, stream.slice(-BACKEND_CHARS), prompts);
  const blocks = later.view(prompts, TITLE);
  assert.equal(blocks.at(-2), prompts.at(-1));
  assert.match(blocks.at(-1).text, /The cache key changed\.\nRebuilding once fixes it\.\nVerified with a clean build\./);
  assert.equal(later.position, stream.length);

  // So much output while unmounted that the prompt's position scrolled out of
  // the snapshot: the prompt goes before the snapshot, output stays visible.
  for (let k = 0; k < 2_000; k++) stream += `test ${k} passed\r\n`;
  const scrolled = mountChatView(sessionId, stream.slice(-BACKEND_CHARS), prompts);
  const scrolledBlocks = scrolled.view(prompts, TITLE);
  assert.equal(scrolledBlocks[0], prompts.at(-1));
  assert.match(scrolledBlocks.at(-1).text, /test 1999 passed$/);
});

test("reset places markers it cannot locate at the start of the snapshot", () => {
  const parser = new ChatTranscriptParser();
  const prompts = [prompt("summarize the log", 300_000, 0)];
  parser.reset("The log shows two retries.\r\n", prompts.map((block) => block.marker));
  const blocks = parser.view(prompts, TITLE);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], prompts[0]);
  assert.equal(blocks[1].text, "The log shows two retries.");
  // New output keeps flowing into the same turn.
  parser.append("Both succeeded.\r\n");
  assert.match(parser.view(prompts, TITLE).at(-1).text, /Both succeeded\.$/);
});

test("chatStreamEndForBuffer maps buffers into stable stream offsets", () => {
  const sessionId = `anchor-${Date.now()}`;
  const first = "alpha\r\n".repeat(100);
  assert.equal(chatStreamEndForBuffer(sessionId, first), first.length);
  // The main buffer dropped its first 350 chars and gained 14 new ones.
  const trimmed = `${first}omega\r\nomega\r\n`.slice(350);
  assert.equal(chatStreamEndForBuffer(sessionId, trimmed), first.length + 14);
  // Unrelated content (anchor scrolled out): everything is treated as new.
  assert.equal(chatStreamEndForBuffer(sessionId, "fresh\r\n"), first.length + 14 + 7);
});

test("boxed startup banners cannot swallow every following reply", () => {
  const parser = new ChatTranscriptParser();
  parser.append("╭──────────────────╮\r\n│ Agent ready │\r\n╰──────────────────╯\r\nThe answer is here.\r\n");
  assert.match(parser.view([], TITLE).map((block) => block.text).join("\n"), /The answer is here/);
});

test("short replies, quotes and code indentation survive terminal fallback", () => {
  const text = "Hi\r\n42\r\n```python\r\nif True:\r\n    print(42)\r\n```\r\n> quoted answer\r\nThe word hello is a greeting.";
  const blocks = parseChatTranscript(text, [prompt("hello", 0, 0)], TITLE);
  const body = blocks.map((block) => block.text).join("\n");
  for (const expected of ["Hi", "42", "    print(42)", "> quoted answer", "The word hello is a greeting."]) assert.ok(body.includes(expected), expected);
});

test("wrapped and multi-line prompt echoes are hidden in terminal fallback", () => {
  const cases = [
    // Claude echoes a multi-line prompt as "> first" plus indented continuation lines.
    ["first line\nsecond line", "> first line\r\n  second line\r\n\r\n⏺ The reply.\r\n"],
    // Terminal wrapping splits a long prompt at a space or inside a word.
    ["please summarize the parser module design in detail", "> please summarize the parser\r\n  module design in de\r\n  tail\r\nThe reply.\r\n"],
    ["describe this image", "> [Image #1] describe this image\r\nThe reply.\r\n"],
    ["a very long pasted prompt\nwith many lines", "> [Pasted text #1 +2 lines]\r\nThe reply.\r\n"],
  ];
  for (const [text, stream] of cases) {
    const prompts = [prompt(text, 0, 0)];
    const blocks = parseChatTranscript(stream, prompts, TITLE);
    const output = blocks.filter((block) => block.role !== "user").map((block) => block.text).join("\n");
    assert.match(output, /The reply\./, text);
    assert.doesNotMatch(output, /first line|second line|summarize|module|tail|Image #1|Pasted text/, text);
    const parser = new ChatTranscriptParser();
    parser.append(stream);
    assert.deepEqual(parser.view(prompts, TITLE), blocks, text);
  }
});

test("reply lines that repeat or quote the prompt outside its echo stay visible", () => {
  const stream = [
    "> rename foo to bar",
    "  keep tests green",
    "Done. I will keep tests green.",
    "keep tests green",
    "> rename foo to bar is what you asked",
    "> quoted answer",
  ].join("\r\n");
  const body = parseChatTranscript(stream, [prompt("rename foo to bar\nkeep tests green", 0, 0)], TITLE)
    .filter((block) => block.role === "assistant")
    .map((block) => block.text)
    .join("\n");
  assert.equal(body, "Done. I will keep tests green.\nkeep tests green\n> rename foo to bar is what you asked\n> quoted answer");
});
