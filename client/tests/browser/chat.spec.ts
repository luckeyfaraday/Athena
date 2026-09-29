import { test, expect } from "@playwright/test";

// The chat endpoint, with or without its ?workspace= hint.
const CHAT_ROUTE = /\/agents\/sessions\/[^/]+\/[^/]+\/chat(?:\?.*)?$/;
const OLD_CONVERSATION = { revision: "old", messages: [
  { id: "u1", role: "user", text: "old question", timestamp: null },
  { id: "a1", role: "assistant", text: "old answer", timestamp: null },
] };

test.beforeEach(async ({ page }) => {
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: { messages: [], revision: "empty" } }));
  await page.goto("/tests/browser/chat.html");
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeVisible();
});

test("multiline sends submit exactly once and preserve their user bubble", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.press("End");
  await composer.type("second line");
  await composer.press("Enter");
  await expect(page.locator(".chatBubble.user pre")).toHaveText("first line\nsecond line");
  await expect(composer).toHaveValue("");
  expect(await page.evaluate(() => (window as any).chatTest.writes)).toEqual(["\x1b[200~first line\nsecond line\x1b[201~", "\r"]);
});

test("send failures keep the draft and never claim it was sent", async ({ page }) => {
  await page.evaluate(() => { (window as any).chatTest.failWrite = true; });
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("please fix it");
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toContainText("PTY disconnected");
  await expect(composer).toHaveValue("please fix it");
  await expect(page.locator(".chatBubble.user")).toHaveCount(0);
  await page.evaluate(() => { (window as any).chatTest.failWrite = false; });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".chatBubble.user pre")).toHaveText("please fix it");
});

test("native replies stay intact and replace terminal redraw noise", async ({ page }) => {
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: {
    revision: "answer", messages: [
      { id: "u1", role: "user", text: "hello", timestamp: null },
      { id: "a1", role: "assistant", text: "Hi\n42\n\n```python\n    print('hello')\n```", timestamp: null },
    ],
  } }));
  await page.evaluate(() => (window as any).chatTest.emit("BROKEN TERMINAL REPAINT\r\n"));
  await expect(page.locator(".chatBubble.assistant")).toContainText("Hi\n42");
  await expect(page.locator(".chatBubble.assistant pre code")).toHaveText("    print('hello')\n");
  await expect(page.getByLabel("Conversation")).not.toContainText("BROKEN TERMINAL REPAINT");
  await page.screenshot({ path: "../reports/chat-browser/native-chat.png" });
});

test("draft survives opening the terminal and returning to chat", async ({ page }) => {
  await page.getByRole("textbox", { name: "Message Codex" }).fill("unfinished draft");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("unfinished draft");
});

test("IME confirmation does not accidentally send a message", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("こんにちは");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  expect(await page.evaluate(() => (window as any).chatTest.writes)).toEqual([]);
  await expect(composer).toHaveValue("こんにちは");
});

test("the stream reconnects after an attach failure", async ({ page }) => {
  await page.evaluate(() => { (window as any).chatTest.failAttach = true; });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("alert")).toContainText("Stream disconnected");
  await page.evaluate(() => { (window as any).chatTest.failAttach = false; });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => (window as any).chatTest.emit("Recovered reply\r\n"));
  await expect(page.locator(".chatBubble.assistant")).toContainText("Recovered reply");
});

test("exited sessions keep their transcript and disable sending", async ({ page }) => {
  await page.evaluate(() => (window as any).chatTest.emit("Completed reply\r\n"));
  await expect(page.locator(".chatBubble.assistant")).toContainText("Completed reply");
  await page.evaluate(() => (window as any).chatTest.setSession({ status: "exited", exitCode: 0 }));
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeDisabled();
  await expect(page.locator(".chatBubble.assistant")).toContainText("Completed reply");
});

test("rapid submission cannot paste a second message during the first send", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("one message");
  await page.locator(".embeddedChatComposer").evaluate((form: HTMLFormElement) => {
    form.requestSubmit(); form.requestSubmit();
  });
  await expect(page.locator(".chatBubble.user")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).chatTest.writes)).toEqual(["\x1b[200~one message\x1b[201~", "\r"]);
});

test("image attachment preserves Windows paths", async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({ name: "example.png", mimeType: "image/png", buffer: Buffer.from("fixture") });
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue('"C:\\my images\\example.png" ');
});

test("native history failures keep previously visible replies", async ({ page }) => {
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: {
    revision: "first", messages: [{ id: "a", role: "assistant", text: "Keep this answer", timestamp: null }],
  } }));
  await expect(page.locator(".chatBubble.assistant")).toContainText("Keep this answer");
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ status: 503, json: { detail: "History temporarily unavailable" } }));
  await expect(page.getByRole("alert")).toContainText("History temporarily unavailable");
  await expect(page.locator(".chatBubble.assistant")).toContainText("Keep this answer");
});

test("chat controls stay inside a narrow pane", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 820 });
  await page.getByRole("textbox", { name: "Message Codex" }).fill("a message\nwith several\nlines");
  const bounds = await page.locator(".embeddedChatTerminal").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
});

test("a session file that does not exist yet is a quiet state, polled cheaply", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (CHAT_ROUTE.test(request.url())) requests.push(request.url()); });
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: { messages: [], revision: "", missing: true } }));
  await page.waitForTimeout(3_000);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Send a message to get started.", { exact: false })).toBeVisible();
  // At most the poll already in flight plus one 2s poll.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.length).toBeLessThanOrEqual(3);
  expect(requests.every((url) => url.includes("workspace=C%3A%2Fproject"))).toBe(true);
  await page.evaluate(() => (window as any).chatTest.emit("Early reply from the terminal\r\n"));
  await expect(page.locator(".chatBubble.assistant")).toContainText("Early reply from the terminal");
});

test("terminal fallback text is shown as plain text, not Markdown", async ({ page }) => {
  const text = "snake_case_name and __init__ stay literal\n    indented line\n# not a heading";
  await page.evaluate((value) => (window as any).chatTest.emit(`${value.replace(/\n/g, "\r\n")}\r\n`), text);
  const bubble = page.locator(".chatBubble.assistant").last();
  await expect(bubble.locator("pre")).toHaveText(text);
  await expect(bubble.locator(".chatMarkdown, strong, em, h1, code")).toHaveCount(0);
});

test("the chat follows the live session when the native file stops recording", async ({ page }) => {
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: OLD_CONVERSATION }));
  await expect(page.locator(".chatBubble.assistant")).toContainText("old answer");
  // After /clear the CLI records into a new session file; the tracked one never changes again.
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await composer.fill("hello again");
  await composer.press("Enter");
  await page.evaluate(() => (window as any).chatTest.emit("› hello again\r\nfresh_reply_name from the new session\r\n"));
  const conversation = page.getByLabel("Conversation");
  await expect(conversation).not.toContainText("fresh_reply_name");
  await expect(conversation).toContainText("fresh_reply_name from the new session", { timeout: 10_000 });
  await expect(page.locator(".chatBubble.user pre")).toHaveText(["old question", "hello again"]);
  await expect(page.locator(".chatBubble.assistant").last().locator("pre")).toHaveText("fresh_reply_name from the new session");
  // Leaving and re-entering the chat view keeps following the terminal.
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.locator(".chatBubble.assistant").last().locator("pre")).toHaveText("fresh_reply_name from the new session");
  await expect(page.locator(".chatBubble.user pre")).toHaveText(["old question", "hello again"]);
  // Once the provider records the turn, native history takes over again.
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: { revision: "new", messages: [
    ...OLD_CONVERSATION.messages,
    { id: "u2", role: "user", text: "hello again", timestamp: null },
    { id: "a2", role: "assistant", text: "**recorded** reply", timestamp: null },
  ] } }));
  await expect(page.locator(".chatBubble.assistant strong")).toHaveText("recorded");
  await expect(conversation).not.toContainText("fresh_reply_name");
  await expect(page.locator(".chatBubble.user pre")).toHaveText(["old question", "hello again"]);
});

test("terminal output does not re-render the chat while native history is shown", async ({ page }) => {
  await page.route(CHAT_ROUTE, (route) => route.fulfill({ json: OLD_CONVERSATION }));
  await expect(page.locator(".chatBubble.assistant")).toContainText("old answer");
  await page.waitForTimeout(1_500);
  const before = await page.evaluate(() => (window as any).chatTest.commits);
  for (let index = 0; index < 5; index++) {
    await page.evaluate((line) => (window as any).chatTest.emit(`streaming line ${line}\r\n`), index);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).chatTest.commits)).toBe(before);
  await expect(page.getByLabel("Conversation")).not.toContainText("streaming line");
});

test("stream reattach retries never pile up", async ({ page }) => {
  // An exit whose output has not arrived yet schedules a recovery reattach (2.5s).
  await page.evaluate(() => (window as any).chatTest.emitExit({ throughSequence: 99 }));
  const before = await page.evaluate(() => {
    const chat = (window as any).chatTest;
    chat.failAttach = true;
    const attaches = chat.attaches;
    chat.emit("stale\r\n", "restarted");
    return attaches;
  });
  // Attach A fails at 0s (retry at 2s), B fails at 2s (retry at 4s), the
  // recovery attach C at 2.5s replaces B's retry (retry at 4.5s), D at 4.5s.
  // A leaked retry would add another attach at 4s.
  await page.waitForTimeout(5_000);
  expect(await page.evaluate(() => (window as any).chatTest.attaches) - before).toBe(4);
});
