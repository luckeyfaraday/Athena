import assert from "node:assert/strict";
import test from "node:test";
import { nativeChatBlocks } from "../src/native-chat.ts";

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
