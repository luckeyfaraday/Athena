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
  for (const query of ["Rename this workspace", "Create a new workspace folder"]) {
    await page.getByRole("combobox").fill(query);
    await expect(page.getByRole("option", { name: new RegExp(query) })).toHaveCount(0);
  }
});

test("remote history loads on demand, paginates without polling, and resumes on the host", async ({ page }) => {
  await selectRemote(page);
  expect(await page.evaluate(() => (window as any).remoteAppTest.historyCalls)).toEqual([]);
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await expect(page.getByText("History desktop:/remote/project:first", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more sessions" }).click();
  await expect(page.getByText("History desktop:/remote/project:page2", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).remoteAppTest.historyCalls)).toEqual([
    ["desktop", "/remote/project", null], ["desktop", "/remote/project", "page2"],
  ]);
  await page.clock.install();
  await page.clock.fastForward(120_000);
  expect(await page.evaluate(() => (window as any).remoteAppTest.historyCalls.length)).toBe(2);
  await page.getByRole("button", { name: "Resume", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: /^Terminals/ })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window as any).remoteAppTest.spawns)).toEqual([
    ["desktop", { workspace: "/remote/project", kind: "claude", count: 1, title: "Claude Resume", resumeSessionId: "/remote/project:first", sessionLabel: "History desktop:/remote/project:first" }],
  ]);
});

test("workspace switches discard late history replies", async ({ page }) => {
  await selectRemote(page);
  await page.evaluate(() => { (window as any).remoteAppTest.historyDelay = true; });
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.historyCalls.length)).toBe(1);
  await page.getByRole("tab", { name: "other", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.historyCalls.length)).toBe(2);
  await page.evaluate(() => (window as any).remoteAppTest.historyResolvers[1]());
  await expect(page.getByText("History desktop:/remote/other:first", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).remoteAppTest.historyResolvers[0]());
  await expect(page.getByText("History desktop:/remote/project:first", { exact: true })).toHaveCount(0);
});

test("resuming descendant history selects its original folder and reveals the pane", async ({ page }) => {
  await selectRemote(page);
  await page.evaluate(() => { (window as any).remoteAppTest.historySubfolder = true; });
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("tab", { name: /child 1 running/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-pane-id="remote:desktop:resumed"]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).remoteAppTest.spawns[0][1].workspace)).toBe("/remote/project/child");
});

test("leaving Sessions during a history request never leaves it stuck loading", async ({ page }) => {
  await selectRemote(page);
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await expect(page.getByText("History desktop:/remote/project:first", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).remoteAppTest.historyDelay = true; });
  await page.getByRole("button", { name: "Load more sessions" }).click();
  await expect(page.getByText("Loading session history…")).toBeVisible();
  await page.getByRole("tab", { name: /^Terminals/ }).click();
  await page.evaluate(() => (window as any).remoteAppTest.historyResolvers[0]());
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await expect(page.getByText("Loading session history…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh sessions" })).toBeEnabled();
  await page.evaluate(() => { (window as any).remoteAppTest.historyDelay = false; });
  await page.getByRole("button", { name: "Load more sessions" }).click();
  await expect(page.getByText("History desktop:/remote/project:page2", { exact: true })).toBeVisible();
});

test("session shortcut opens remote history from Settings", async ({ page }) => {
  await selectRemote(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Control+Shift+KeyS");
  await expect(page.getByText("History desktop:/remote/project:first", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+Shift+KeyS");
  await expect(page.getByRole("tab", { name: /^Terminals/ })).toHaveAttribute("aria-selected", "true");
});

test("failed resume remains in Sessions and cannot launch duplicates while pending", async ({ page }) => {
  await selectRemote(page);
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.assign((window as any).remoteAppTest, { spawnDelay: true, spawnError: "Host is low on memory" });
  });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).remoteAppTest.spawnResolvers[0]());
  await expect(page.getByText("Host is low on memory", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Sessions/ })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window as any).remoteAppTest.spawns.length)).toBe(1);
});

test("old host history error stays in Sessions while terminals remain usable", async ({ page }) => {
  await selectRemote(page);
  await page.evaluate(() => { (window as any).remoteAppTest.historyError = "Update Athena on this device to enable session history."; });
  await palette(page, "Show session history");
  await page.getByRole("option", { name: /Show session history/ }).click();
  await expect(page.getByText("Update Athena on this device to enable session history.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Terminals/ }).click();
  await page.getByRole("button", { name: "New Shell", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.spawns.length)).toBe(1);
});

test("devices with identical paths have independent history and hide preferences", async ({ page }) => {
  await selectRemote(page);
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await page.getByRole("button", { name: "Hide History desktop:/remote/project:first", exact: true }).click();
  await page.locator(".machineSwitcherButton").click();
  await page.getByRole("menuitemradio", { name: /travel/ }).click();
  await page.getByRole("tab", { name: /^Sessions/ }).click();
  await expect(page.getByText("History second:/remote/project:first", { exact: true })).toBeVisible();
  await expect(page.getByText("History desktop:/remote/project:first", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  expect(await page.evaluate(() => (window as any).remoteAppTest.spawns[0][0])).toBe("second");
});

test("local palette closing still targets the local workspace", async ({ page }) => {
  await palette(page, "Close this workspace");
  await page.getByRole("option", { name: /Close this workspace/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Close project?");
  await page.getByRole("button", { name: "Stop and close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).remoteAppTest.killed)).toEqual(["local-job"]);
  expect(await page.evaluate(() => (window as any).remoteAppTest.closed)).toEqual([]);
});
