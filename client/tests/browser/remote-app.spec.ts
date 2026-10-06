import { test, expect, type Page } from "@playwright/test";

async function palette(page: Page, query: string) {
  await page.getByRole("button", { name: "Open the command palette", exact: true }).click();
  await page.getByRole("combobox").fill(query);
}

async function selectRemote(page: Page) {
  await page.locator(".machineSwitcherButton").click();
  await page.getByRole("menuitemradio", { name: /omarchy/ }).click();
  await expect(page.locator(".remoteMachineLabel")).toHaveText("on omarchy");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/remote-app.html");
  await expect(page.getByRole("tab", { name: /project 1 running/ })).toBeVisible();
});

test("closing a remote workspace from the palette never kills the local job", async ({ page }) => {
  await selectRemote(page);
  await palette(page, "Close this workspace");
  await page.getByRole("option", { name: /Close this workspace/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Close project on omarchy?");
  await page.getByRole("button", { name: "Close and stop", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.closed)).toEqual([["desktop", "/remote/project"]]);
  expect(await page.evaluate(() => (window as any).remoteAppTest.killed)).toEqual([]);
});

for (const action of ["palette", "shortcut"] as const) {
  test(`remote launch from Settings through ${action} starts exactly one shell`, async ({ page }) => {
    await selectRemote(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".remoteMachineLabel")).toHaveCount(0);
    if (action === "palette") {
      await palette(page, "New shell");
      await page.getByRole("option", { name: /New shell/ }).click();
    } else {
      await page.keyboard.press("Control+Shift+KeyT");
    }
    await expect(page.locator(".remoteMachineLabel")).toHaveText("on omarchy");
    await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.spawns)).toEqual([
      ["desktop", { workspace: "/remote/project", kind: "shell", count: 1 }],
    ]);
  });
}

test("palette switches remote workspaces and subsequent launches use that folder", async ({ page }) => {
  await selectRemote(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await palette(page, "Switch to other");
  await expect(page.getByRole("option", { name: /Switch to other/ })).toContainText("/remote/other");
  await page.getByRole("option", { name: /Switch to other/ }).click();
  await expect(page.getByRole("tab", { name: "other", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "New Shell", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.spawns)).toEqual([
    ["desktop", { workspace: "/remote/other", kind: "shell", count: 1 }],
  ]);
});

test("adding a workspace from Settings browses the selected host", async ({ page }) => {
  await selectRemote(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await palette(page, "Add a workspace folder");
  await page.getByRole("option", { name: /Add a workspace folder/ }).click();
  await expect(page.getByRole("dialog", { name: "Open a folder on omarchy" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.directories.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).remoteAppTest.directories.every(([id]: string[]) => id === "desktop"))).toBe(true);
});

test("remote palette omits local-only actions and local panes", async ({ page }) => {
  await selectRemote(page);
  await palette(page, "Go to");
  await expect(page.getByRole("option", { name: /Go to remote:desktop:remote-job/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Go to local-job/ })).toHaveCount(0);
  for (const query of ["Rename this workspace", "Create a new workspace folder", "Show session history"]) {
    await page.getByRole("combobox").fill(query);
    await expect(page.getByRole("option", { name: new RegExp(query) })).toHaveCount(0);
  }
});

test("local palette closing still targets the local workspace", async ({ page }) => {
  await palette(page, "Close this workspace");
  await page.getByRole("option", { name: /Close this workspace/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Close project?");
  await page.getByRole("button", { name: "Stop and close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.killed)).toEqual(["local-job"]);
  expect(await page.evaluate(() => (window as any).remoteAppTest.closed)).toEqual([]);
});
