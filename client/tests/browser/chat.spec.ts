import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/agents/sessions/**/chat", (route) => route.fulfill({ json: { messages: [], revision: "empty" } }));
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
  await page.route("**/agents/sessions/**/chat", (route) => route.fulfill({ json: {
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
  await page.route("**/agents/sessions/**/chat", (route) => route.fulfill({ json: {
    revision: "first", messages: [{ id: "a", role: "assistant", text: "Keep this answer", timestamp: null }],
  } }));
  await expect(page.locator(".chatBubble.assistant")).toContainText("Keep this answer");
  await page.route("**/agents/sessions/**/chat", (route) => route.fulfill({ status: 503, json: { detail: "History temporarily unavailable" } }));
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
