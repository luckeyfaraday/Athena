import assert from "node:assert/strict";
import test from "node:test";
import { nativeChatBlocks, nativeChatView, nextUnrecordedCheck, unrecordedPrompt, withTerminalTail } from "../src/native-chat.ts";

const message = (id, role, text) => ({ id, role, text, timestamp: null });
const prompt = (id, text, nativeAfter = "") => ({ id, role: "user", label: "You", text, marker: 0, sentAt: 1000, nativeAfter });

test("native messages preserve short answers, formatting and transcript order", () => {
  const messages = [message("1", "user", "answer"), message("2", "assistant", "42\n\n```py\n    return True\n```")];
  assert.deepEqual(nativeChatBlocks(messages, [], "Codex", new Map()).map(({ role, text }) => ({ role, text })), messages.map(({ role, text }) => ({ role, text })));
});

test("a sent prompt stays visible until its own native user message arrives", () => {
  const history = [message("1", "user", "again"), message("2", "assistant", "done")];
  const sent = prompt("local", "again", "2");
  const confirmed = new Map();
  assert.equal(nativeChatBlocks(history, [sent], "Codex", confirmed).at(-1), sent);
  history.push(message("3", "user", "again"));
  assert.equal(nativeChatBlocks(history, [sent], "Codex", confirmed).length, 3);
  assert.equal(nativeChatBlocks(history.slice(-1), [sent], "Codex", confirmed).length, 1);
});

test("two identical pending prompts cannot acknowledge each other", () => {
  const prompts = [prompt("a", "again"), prompt("b", "again")];
  const confirmed = new Map();
  const history = [message("1", "user", "again")];
  assert.equal(nativeChatBlocks(history, prompts, "Codex", confirmed).at(-1), prompts[1]);
  assert.equal(nativeChatBlocks(history, prompts, "Codex", confirmed).at(-1), prompts[1]);
  history.push(message("2", "assistant", "done"), message("3", "user", "again"));
  assert.equal(nativeChatBlocks(history, prompts, "Codex", confirmed).length, 3);
});

const timed = (id, text, timestamp) => ({ id, role: "user", text, timestamp });

test("native assistant replies are Markdown; user messages are not", () => {
  const blocks = nativeChatBlocks([message("1", "user", "**hi**"), message("2", "assistant", "**bold**")], [], "Claude", new Map());
  assert.deepEqual(blocks.map((block) => block.markdown), [undefined, true]);
});

test("prompts recorded with attachment placeholders or extra text still replace their bubble", () => {
  const history = [message("1", "assistant", "ready")];
  const image = prompt("image", String.raw`"C:\my images\example.png" describe this image`, "1");
  const pasted = prompt("pasted", "summarize the attached release notes", "1");
  history.push(message("2", "user", "[Image #1] describe this image"), message("3", "assistant", "A cat."));
  history.push(message("4", "user", "summarize the attached release notes\n\n<system-reminder>context</system-reminder>"));
  const view = nativeChatView(history, [image, pasted], "Claude", new Map());
  assert.deepEqual(view.pending, []);
  assert.equal(view.blocks.length, 4);
});

test("a prompt recorded in a different form is matched by its position after the send", () => {
  const history = [message("1", "assistant", "ready")];
  const sent = prompt("local", "yes", "1");
  const confirmed = new Map();
  assert.deepEqual(nativeChatView(history, [sent], "Codex", confirmed).pending, [sent]);
  history.push(message("2", "user", "Yes."), message("3", "assistant", "Proceeding."));
  assert.deepEqual(nativeChatView(history, [sent], "Codex", confirmed).pending, []);
  assert.equal(confirmed.get("local"), "2");
});

test("a send that never becomes a record expires once a later send is recorded", () => {
  const history = [message("1", "assistant", "ready")];
  const command = prompt("command", "/model", "1");
  const next = prompt("next", "continue with the refactor", "1");
  assert.deepEqual(nativeChatView(history, [command, next], "Claude", new Map()).pending, [command, next]);
  history.push(message("2", "user", "continue with the refactor"), message("3", "assistant", "Done."));
  const view = nativeChatView(history, [command, next], "Claude", new Map());
  assert.deepEqual(view.pending, []);
  assert.deepEqual(view.blocks.map((block) => block.text), ["ready", "continue with the refactor", "Done."]);
});

test("broadcast prompts only match records written after the send", () => {
  const sent = { ...prompt("broadcast", "run the tests"), nativeAfter: undefined, sentAt: Date.parse("2026-09-29T10:00:00Z") };
  const older = timed("1", "run the tests", "2026-09-29T09:00:00Z");
  assert.deepEqual(nativeChatView([older], [sent], "Codex", new Map()).pending, [sent]);
  const recorded = timed("2", "Run the tests.", "2026-09-29T10:00:01Z");
  assert.deepEqual(nativeChatView([older, recorded], [sent], "Codex", new Map()).pending, []);
});

test("the launch task shows until native history records it, even reflowed onto one line", () => {
  const task = { id: "prompt-initial", role: "user", label: "You", text: "Fix the login bug\nand add a test", marker: 0 };
  assert.deepEqual(nativeChatView([], [task], "OpenCode", new Map()).pending, [task]);
  const view = nativeChatView([message("m1", "user", "Fix the login bug and add a test")], [task], "OpenCode", new Map());
  assert.deepEqual(view.pending, []);
  assert.deepEqual(view.blocks.map((block) => block.text), ["Fix the login bug and add a test"]);
});

test("an unrecorded send hands the rest of the transcript to the terminal", () => {
  const sent = { ...prompt("after-clear", "hello again", "2"), sentAt: 10_000 };
  const history = [message("1", "user", "old question"), message("2", "assistant", "old answer")];
  const view = nativeChatView(history, [sent], "Claude", new Map());
  assert.equal(unrecordedPrompt(view.pending, 5_000, 12_000), undefined, "still within the grace period");
  assert.equal(nextUnrecordedCheck(view.pending, 5_000), 16_000);
  assert.equal(unrecordedPrompt(view.pending, 11_000, 20_000), undefined, "the native session changed after the send");
  assert.equal(nextUnrecordedCheck(view.pending, 11_000), null);
  const from = unrecordedPrompt(view.pending, 5_000, 16_000);
  assert.equal(from, sent);
  const terminal = [
    { id: "output-0-0-old", role: "assistant", label: "Claude", text: "old answer" },
    sent,
    { id: "output-1-0-fresh", role: "assistant", label: "Claude", text: "fresh_reply_name" },
  ];
  const blocks = withTerminalTail(view, from, terminal);
  assert.deepEqual(blocks.map((block) => block.text), ["old question", "old answer", "hello again", "fresh_reply_name"]);
  assert.equal(blocks.at(-1).markdown, undefined);
  assert.deepEqual(withTerminalTail(view, undefined, terminal).map((block) => block.text), ["old question", "old answer", "hello again"]);
});
