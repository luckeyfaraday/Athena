import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/remote-settings.html");
  await expect(page.getByLabel("Access token for desktop", { exact: true })).toBeVisible();
});

test("token-only pairing accepts a token, clears the draft and can forget it", async ({ page }) => {
  const token = page.getByLabel("Access token for desktop", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Save token", exact: true })).toBeDisabled();
  await token.fill("  athena_remote_test  ");
  await token.press("Enter");
  await expect(page.getByRole("status")).toContainText("Connected.");
  await expect(token).toHaveValue("");
  expect(await page.evaluate(() => (window as any).remoteSettingsTest.writes)).toEqual([
    { id: "desktop-id", token: "athena_remote_test" },
  ]);
  expect(await page.evaluate(() => (window as any).remoteSettingsTest.switcherReady)).toBe(true);
  await page.getByRole("button", { name: "Forget token", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved token removed.");
  await expect(page.locator(".remoteMachineList")).toContainText("Needs token");
  expect(await page.evaluate(() => (window as any).remoteSettingsTest.writes.at(-1))).toEqual({ id: "desktop-id", token: null });
});

test("a rejected token can be replaced and credential-bearing errors stay private", async ({ page }) => {
  const token = page.getByLabel("Access token for desktop", { exact: true });
  await token.fill("wrong-token");
  await token.press("Enter");
  await expect(page.getByRole("alert")).toContainText("This token was rejected");
  await expect(token).toHaveValue("");
  await page.evaluate(() => { (window as any).remoteSettingsTest.failSave = true; });
  await token.fill("private-test-token");
  await token.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Could not update the connection. Check again and retry.");
  await expect(page.locator("body")).not.toContainText("private-test-token");
  await expect(token).toHaveValue("private-test-token");
  await page.evaluate(() => { (window as any).remoteSettingsTest.failSave = false; });
  await token.fill("athena_remote_test");
  await token.press("Enter");
  await expect(page.getByRole("status")).toContainText("Connected.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Check again reconciles the switcher immediately", async ({ page }) => {
  await page.evaluate(() => { (window as any).remoteSettingsTest.machine.status = "ready"; });
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.locator(".remoteMachineList")).toContainText("Ready");
  expect(await page.evaluate(() => (window as any).remoteSettingsTest.refreshes)).toBe(1);
  expect(await page.evaluate(() => (window as any).remoteSettingsTest.switcherReady)).toBe(true);
});
