// Settings navigation. Kept out of SettingsRoom.tsx so the command palette can
// deep-link into Settings without loading the room's code up front.

export type SettingsSection = "appearance" | "workspace" | "notifications" | "agents" | "system" | "diagnostics" | "shortcuts";

export const settingsSections: ReadonlyArray<{ id: SettingsSection; label: string; description: string }> = [
  { id: "appearance", label: "Appearance", description: "Theme, density, and terminal text." },
  { id: "workspace", label: "Workspace", description: "Project folder and terminal restore." },
  { id: "notifications", label: "Notifications", description: "When and how agents get your attention." },
  { id: "agents", label: "Agents", description: "Coding agent CLIs and the Hermes MCP bridge." },
  { id: "system", label: "System", description: "Backend, Electron control, and graphics." },
  { id: "diagnostics", label: "Diagnostics", description: "Terminal throughput and process details." },
  { id: "shortcuts", label: "Keyboard shortcuts", description: "Every app-wide shortcut." },
];
