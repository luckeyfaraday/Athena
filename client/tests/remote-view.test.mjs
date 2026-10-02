import assert from "node:assert/strict";
import test from "node:test";

import {
  hasRemoteMachines,
  isRemoteSessionId,
  machineWorkspaceAttention,
  pickRemoteWorkspace,
  remoteAttentionKey,
  remoteLaunchError,
  remoteMachineIdOf,
  remoteWorkspacePath,
  remoteWorkspaceTabs,
  sessionsInWorkspace,
  switcherEntries,
} from "../src/remote-view.ts";

function session(id, workspace, status = "running") {
  return { id: `remote:nLAPTOP:${id}`, title: id, kind: "claude", workspace, pid: 1, promptPath: null, initialTask: null, sessionLabel: null, providerSessionId: null, createdAt: "", status, exitCode: null, error: null };
}

function machine(overrides = {}) {
  return {
    id: "nLAPTOP", name: "surface", dnsName: null, os: "linux", online: true, address: "100.124.147.99", url: "http://100.124.147.99:47821",
    owner: null, ownDevice: true, status: "ready", detail: null, version: "0.3.1", platform: "linux", homedir: "/home/alan", checkedAt: null,
    connection: "connected", connectionError: null, hasToken: false,
    sessions: [], workspaces: [], activeWorkspace: null,
    ...overrides,
  };
}

test("remote session ids name their machine", () => {
  assert.equal(isRemoteSessionId("remote:nLAPTOP:abc"), true);
  assert.equal(isRemoteSessionId("abc"), false);
  assert.equal(remoteMachineIdOf("remote:nLAPTOP:abc:def"), "nLAPTOP");
  assert.equal(remoteMachineIdOf("remote::abc"), null);
  assert.equal(remoteMachineIdOf("local"), null);
});

test("remoteWorkspaceTabs keeps the machine's own tabs first and adds folders that only have terminals", () => {
  const tabs = remoteWorkspaceTabs(machine({
    workspaces: [remoteWorkspacePath("/home/alan/app"), remoteWorkspacePath("C:\\Users\\alan\\api")],
    sessions: [session("a", "/home/alan/app"), session("b", "/srv/tools"), session("c", "c:/users/alan/api")],
  }));
  assert.deepEqual(tabs.map((tab) => tab.nativePath), ["/home/alan/app", "C:\\Users\\alan\\api", "/srv/tools"]);
});

test("pickRemoteWorkspace prefers what was picked here, then the machine's active tab, then the first", () => {
  const tabs = ["/a", "/b", "/c"].map(remoteWorkspacePath);
  assert.equal(pickRemoteWorkspace(tabs, "/c", tabs[1]).nativePath, "/c");
  assert.equal(pickRemoteWorkspace(tabs, "/gone", tabs[1]).nativePath, "/b");
  assert.equal(pickRemoteWorkspace(tabs, null, null).nativePath, "/a");
  assert.equal(pickRemoteWorkspace([], "/a", null), null);
});

test("switcherEntries lists ready and token-needing machines, plus the one being viewed", () => {
  const snapshot = {
    tailscale: "running", account: null, selfName: "omarchy", refreshedAt: null,
    machines: [
      machine({ sessions: [session("a", "/x"), session("b", "/x", "exited")] }),
      machine({ id: "nFRIEND", name: "friend-pc", status: "needs-token", connection: "idle" }),
      machine({ id: "nOLD", name: "old-book", status: "offline", connection: "idle" }),
      machine({ id: "nWIN", name: "win-pc", status: "no-athena", connection: "idle" }),
      machine({ id: "nNEW", name: "new-box", connection: "connecting" }),
      machine({ id: "nFLAKY", name: "flaky", connection: "error" }),
    ],
  };
  assert.deepEqual(switcherEntries(snapshot, null).map((entry) => [entry.name, entry.available, entry.state, entry.running]), [
    ["surface", true, "1 running", 1],
    ["friend-pc", false, "Needs token", 0],
    ["new-box", true, "Connecting…", 0],
    ["flaky", true, "Reconnecting…", 0],
  ]);
  const viewingGone = switcherEntries(snapshot, "nWIN").find((entry) => entry.id === "nWIN");
  assert.deepEqual([viewingGone.available, viewingGone.state], [false, "Not answering"]);
  assert.equal(hasRemoteMachines(snapshot, null), true);
  assert.equal(hasRemoteMachines({ ...snapshot, machines: [snapshot.machines[2]] }, null), false);
  assert.deepEqual(switcherEntries(null, null), []);
});

test("remote attention keys separate machines and normalize paths", () => {
  assert.equal(remoteAttentionKey("nLAPTOP", "C:\\Users\\alan\\api"), "remote:nLAPTOP:c:/users/alan/api");
  assert.notEqual(remoteAttentionKey("nA", "/x"), remoteAttentionKey("nB", "/x"));
  const forLaptop = machineWorkspaceAttention({
    [remoteAttentionKey("nLAPTOP", "/home/alan/app")]: { kind: "action", count: 1 },
    [remoteAttentionKey("nOTHER", "/home/alan/app")]: { kind: "update", count: 1 },
    "/home/alan/local": { kind: "update", count: 1 },
  }, "nLAPTOP");
  assert.deepEqual(forLaptop, { "/home/alan/app": { kind: "action", count: 1 } });
});

test("sessionsInWorkspace matches paths the way tabs do", () => {
  const sessions = [session("a", "/home/alan/app/"), session("b", "/home/alan/other")];
  assert.deepEqual(sessionsInWorkspace(sessions, "/home/alan/app").map((item) => item.title), ["a"]);
});

test("remoteLaunchError names the machine for missing agents and dropped connections", () => {
  assert.equal(
    remoteLaunchError(new Error("Error invoking remote method 'remote:spawn': RemoteRequestError: Claude Code (claude) is not installed or not on PATH."), "surface"),
    "Claude Code (claude) is not installed or not on PATH on surface.",
  );
  assert.equal(remoteLaunchError(new Error("connect ECONNREFUSED 100.124.147.99:47821"), "surface"), "surface stopped answering. Check that Athena is still running there.");
  assert.equal(remoteLaunchError("Project directory is not a directory: /x", "surface"), "Project directory is not a directory: /x");
});
