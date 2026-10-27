import { test, expect, type Page } from "@playwright/test";

async function palette(page: Page, query: string) {
  await page.getByRole("button", { name: "Open the command palette", exact: true }).click();
  await page.getByRole("combobox").fill(query);
}

async function open(page: Page, query = "") {
  await page.goto(`/tests/browser/jarvis.html${query}`);
  await expect(page.getByRole("tab", { name: /project 2 running/ })).toBeVisible();
}

const dock = (page: Page) => page.getByRole("region", { name: "Jarvis", exact: true });
const push = (page: Page, patch: Record<string, unknown>) => page.evaluate((value) => (window as any).jarvisTest.push(value), patch);

test("without a Jarvis license the Command Room has no dock and the palette only links to Settings", async ({ page }) => {
  await open(page, "?licensed=0");
  await expect(dock(page)).toHaveCount(0);
  await palette(page, "Jarvis");
  await expect(page.getByRole("option", { name: /Open Jarvis settings/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Ask Jarvis/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /toggle microphone/ })).toHaveCount(0);
  await page.getByRole("option", { name: /Open Jarvis settings/ }).click();
  await expect(page.getByRole("heading", { name: "Jarvis", exact: true })).toBeVisible();
  await expect(page.getByText("Jarvis is not activated on this computer.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Jarvis is a separate app with its own license/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Jarvis", exact: true })).toHaveCount(0);
});

test("a typed request goes to Jarvis on Enter and a failure stays inline with the draft", async ({ page }) => {
  await open(page);
  await expect(dock(page)).toContainText("Not running");
  const input = page.getByRole("textbox", { name: "Ask Jarvis", exact: true });
  await page.evaluate(() => { (window as any).jarvisTest.askError = "Error invoking remote method 'jarvis:ask': Error: Jarvis is not running"; });
  await input.fill("start codex on omarchy");
  await input.press("Enter");
  await expect(dock(page).getByRole("alert")).toHaveText("Jarvis is not running.");
  await expect(input).toHaveValue("start codex on omarchy");
  await page.evaluate(() => { (window as any).jarvisTest.askError = null; });
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(dock(page).getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("log", { name: "Jarvis conversation" })).toContainText("start codex on omarchy");
  expect(await page.evaluate(() => (window as any).jarvisTest.asks)).toEqual(["start codex on omarchy"]);
  await dock(page).getByRole("button", { name: "Open Jarvis", exact: true }).click();
  await expect(dock(page)).toContainText("Opening…");
  expect(await page.evaluate(() => (window as any).jarvisTest.launches)).toBe(1);
});

test("live state drives the orb, the transcript, the feed and the mic", async ({ page }) => {
  await open(page);
  await push(page, { running: true, connected: true, micOpen: true, activity: "listening", partial: "what is codex doing" });
  await expect(dock(page).locator(".jarvisOrb.listening")).toHaveCount(1);
  await expect(page.getByRole("log", { name: "Jarvis conversation" })).toContainText("what is codex doing");
  await push(page, {
    activity: "speaking",
    partial: null,
    feed: [
      { id: 1, at: Date.now(), kind: "heard", text: "what is codex doing" },
      { id: 2, at: Date.now(), kind: "said", text: "Codex on omarchy is running the tests." },
      { id: 3, at: Date.now(), kind: "agent", agent: "claude in athena", text: "stop: turn complete" },
    ],
  });
  const log = page.getByRole("log", { name: "Jarvis conversation" });
  await expect(log.locator(".jarvisFeedItem.jarvis")).toContainText("Codex on omarchy is running the tests.");
  await expect(log.locator(".jarvisFeedItem.system")).toContainText("claude in athena");
  await expect(dock(page)).toContainText("Speaking");
  const mic = dock(page).getByRole("button", { name: "Jarvis microphone", exact: true });
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => (window as any).jarvisTest.mics)).toEqual(["toggle"]);
});

test("collapsing keeps one line with the live transcript and is remembered", async ({ page }) => {
  await open(page);
  await push(page, { running: true, connected: true, micOpen: true, partial: "open the athena repo" });
  await dock(page).getByRole("button", { name: "Hide the Jarvis feed", exact: true }).click();
  await expect(page.getByRole("log", { name: "Jarvis conversation" })).toBeHidden();
  await expect(dock(page).locator(".jarvisPreview")).toContainText("open the athena repo");
  expect(await page.evaluate(() => (window as any).jarvisTest.preferences)).toContainEqual(["context-workspace:jarvisDock", "collapsed"]);
  await page.reload();
  await expect(dock(page).getByRole("button", { name: "Show the Jarvis feed", exact: true })).toBeVisible();
});

test("the palette asks Jarvis from Settings and toggles its microphone", async ({ page }) => {
  await open(page);
  await push(page, { running: true, connected: true, micOpen: false });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await palette(page, "Ask Jarvis");
  await page.getByRole("option", { name: /Ask Jarvis/ }).click();
  await expect(page.getByRole("textbox", { name: "Ask Jarvis", exact: true })).toBeFocused();
  await palette(page, "Jarvis: toggle microphone");
  await expect(page.getByRole("option", { name: /toggle microphone/ })).toContainText("Microphone is off");
  await page.getByRole("option", { name: /toggle microphone/ }).click();
  await expect(page.getByText("Jarvis is listening", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).jarvisTest.mics)).toEqual(["toggle"]);
});

test("Settings shows the license and opens Jarvis when it is not running", async ({ page }) => {
  await open(page);
  await palette(page, "Open Jarvis settings");
  await page.getByRole("option", { name: /Open Jarvis settings/ }).click();
  await expect(page.getByText(/^Verified on this computer \(omarchy\)\. Works offline until/)).toBeVisible();
  await expect(page.getByText("JARV-••••-••••-7Q2K", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Jarvis", exact: true }).click();
  expect(await page.evaluate(() => (window as any).jarvisTest.launches)).toBe(1);
  await push(page, { running: true, connected: true, micOpen: true, provider: "anthropic", model: "claude-sonnet-4-5" });
  await expect(page.getByText("Linked to Jarvis, which is using anthropic · claude-sonnet-4-5.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Jarvis", exact: true })).toHaveCount(0);
  await page.getByRole("group", { name: "Microphone" }).getByRole("button", { name: "Off" }).click();
  expect(await page.evaluate(() => (window as any).jarvisTest.mics)).toEqual(["off"]);
});
