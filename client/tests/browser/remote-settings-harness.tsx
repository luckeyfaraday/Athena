import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/tokens.css";
import "../../src/styles/themes.css";
import "../../src/styles.css";

const machine = {
  id: "desktop-id", name: "desktop", dnsName: "desktop.example.ts.net", os: "linux", online: true,
  address: "100.64.0.2", url: "http://100.64.0.2:47821", owner: "me@example.com", ownDevice: true,
  status: "needs-token", detail: "Needs its access token.", version: "0.3.0", platform: "linux",
  homedir: "/home/test", checkedAt: null,
};
const state = (window as any).remoteSettingsTest = {
  writes: [] as Array<{ id: string; token: string | null }>, refreshes: 0, failSave: false,
  switcherReady: false, machine,
};
const directory = () => ({ tailscale: "running", account: "me@example.com", port: 47821, machines: [{ ...machine }], refreshedAt: null });
(window as any).contextWorkspace = {
  getRemoteAccessState: async () => ({
    enabled: false, port: 47821, urls: [], dnsUrl: null, trustOwnDevices: false,
    tailscale: { detected: true, backendState: "Running", dnsName: null, hostName: "viewer", account: "me@example.com" },
    hasToken: false, errors: [], lastRequest: null, lastRejected: null,
  }),
  getRemoteMachines: async () => directory(),
  refreshRemote: async () => {
    state.refreshes++;
    state.switcherReady = machine.status === "ready";
    return directory();
  },
  setRemoteMachineToken: async (id: string, token: string | null) => {
    state.writes.push({ id, token });
    if (state.failSave) throw new Error(`IPC failure containing ${token}`);
    machine.status = token === "athena_remote_test" ? "ready" : "needs-token";
    state.switcherReady = machine.status === "ready";
    return directory();
  },
};
const { SettingsRoom } = await import("../../src/rooms/SettingsRoom");
const noop = async () => {};
createRoot(document.getElementById("root")!).render(<SettingsRoom
  workspace="" backend={null} electronControl={null} hermes={null} adapters={{}} busy={false}
  installingHermes={false} interfaceMode="terminal" uiTheme="system" resolvedTheme={"dark" as any}
  performance={null} launchState={null} graphics={null} agentClis={null} canRunSetup={false}
  notificationPreferences={{} as any} terminalAppearance={{} as any} density="default" section="system"
  onSelectWorkspace={noop} onRestartBackend={noop} onRestartControl={noop} onClearTerminalRestorePause={noop}
  onInstallHermes={noop} onAgentSetup={noop} onRefreshDiagnostics={noop} onInterfaceModeChange={noop}
  onThemeChange={noop} onGraphicsPreferenceChange={noop} onNotificationPreferencesChange={noop}
  onPreviewAttentionSound={noop} onDensityChange={noop} onTerminalAppearanceChange={noop} onSectionChange={noop}
/>);
