// Display helpers for the Jarvis dock (Command Room) and Settings > Jarvis.
// Pure functions only, so they can be unit tested in Node.

import type { JarvisFeedItem, JarvisLicenseState, JarvisState } from "./electron";

export type JarvisStatusView = { tone: "ok" | "warn" | "muted"; label: string };

// A license this close to lapsing offline gets a nudge to open Jarvis online.
const LICENSE_RENEW_SOON_MS = 3 * 24 * 60 * 60_000;

export function jarvisLicenseView(license: JarvisLicenseState | null, now = Date.now()): JarvisStatusView {
  if (!license) return { tone: "muted", label: "Checking" };
  if (!license.licensed) return { tone: "muted", label: "Not licensed" };
  if (license.offlineUntil != null && license.offlineUntil - now < LICENSE_RENEW_SOON_MS) return { tone: "warn", label: "Renew soon" };
  return { tone: "ok", label: "Licensed" };
}

/** How long the license holds offline, or why it does not count, phrased for Settings. */
export function jarvisLicenseSummary(license: JarvisLicenseState, now = Date.now()): string {
  if (!license.licensed) return sentence(license.detail ?? "Jarvis is not activated on this computer");
  const where = license.instanceName ? ` (${license.instanceName})` : "";
  if (license.offlineUntil == null) return `Verified on this computer${where}.`;
  const until = formatDate(license.offlineUntil);
  if (license.offlineUntil - now < LICENSE_RENEW_SOON_MS) {
    return `Verified on this computer${where} until ${until}. Open Jarvis while online to renew it.`;
  }
  return `Verified on this computer${where}. Works offline until ${until}; Jarvis renews it whenever it is online.`;
}

/** The link to Jarvis on this computer. Without a license nothing here is a fault, so nothing warns. */
export function jarvisStatusView(state: JarvisState | null): JarvisStatusView {
  if (!state) return { tone: "muted", label: "Checking" };
  const licensed = state.license.licensed;
  if (state.connected) return { tone: "ok", label: "Connected" };
  if (state.running) return licensed ? { tone: "warn", label: "Connecting" } : { tone: "muted", label: "Not linked" };
  if (!state.installPath) return { tone: licensed ? "warn" : "muted", label: "Not installed" };
  return { tone: "muted", label: "Not running" };
}

export function jarvisConnectionSummary(state: JarvisState | null): string {
  if (!state) return "Looking for Jarvis on this computer…";
  if (state.connected) {
    const model = jarvisModelLabel(state);
    return model ? `Linked to Jarvis, which is using ${model}.` : "Linked to Jarvis.";
  }
  if (state.running) {
    return state.license.licensed
      ? "Jarvis is running. Linking to it…"
      : "Jarvis is running, but Athena links to it only when this computer holds a Jarvis license.";
  }
  return "Jarvis is not running. Athena links to it as soon as it starts.";
}

/** "anthropic · claude-sonnet-4-5", either half alone, or null. */
export function jarvisModelLabel(state: JarvisState | null): string | null {
  const parts = [state?.provider, state?.model].filter((part): part is string => Boolean(part?.trim()));
  return parts.length ? parts.join(" · ") : null;
}

/** The expanded dock's subtitle: the model and how many of Jarvis's own agents are working. */
export function jarvisDockMeta(state: JarvisState | null): string | null {
  const working = state?.agents.filter((agent) => agent.working).length ?? 0;
  const parts = [jarvisModelLabel(state), working ? `${working} ${working === 1 ? "agent" : "agents"} working` : null];
  return parts.filter(Boolean).join(" · ") || null;
}

export type JarvisOrbTone = "offline" | "idle" | "listening" | "thinking" | "speaking";

/** The dock's orb and the word beside it. Activity only means something while Athena is attached. */
export function jarvisActivityView(state: JarvisState | null): { tone: JarvisOrbTone; label: string } {
  if (!state?.running) return { tone: "offline", label: "Not running" };
  if (!state.connected) return { tone: "offline", label: "Connecting…" };
  if (state.activity === "listening") return { tone: "listening", label: "Listening" };
  if (state.activity === "thinking") return { tone: "thinking", label: "Thinking" };
  if (state.activity === "speaking") return { tone: "speaking", label: "Speaking" };
  return { tone: "idle", label: state.micOpen === false ? "Mic off" : "Ready" };
}

export type JarvisFeedRole = "user" | "jarvis" | "system";

/** The user (spoken or typed), Jarvis, or the system (announcements, agent events). */
export function jarvisFeedRole(item: JarvisFeedItem): JarvisFeedRole {
  if (item.kind === "heard" || item.kind === "asked") return "user";
  return item.kind === "said" ? "jarvis" : "system";
}

export function jarvisFeedLabel(item: JarvisFeedItem): string {
  switch (item.kind) {
    case "heard": return "You";
    // Typed requests from the control API (a phone, another machine) arrive as "remote".
    case "asked": return item.agent === "remote" ? "You, typed remotely" : "You, typed";
    case "said": return "Jarvis";
    case "announce": return "Announcement";
    default: return item.agent || "Agent";
  }
}

/** One line for the collapsed dock: what Jarvis is hearing right now, else the latest feed item. */
export function jarvisDockPreview(state: JarvisState | null): { text: string; live: boolean } | null {
  if (state?.partial) return { text: state.partial, live: true };
  const last = state?.feed.at(-1);
  return last ? { text: `${jarvisFeedLabel(last)}: ${last.text}`, live: false } : null;
}

/** "just now", "40s ago", "3m ago", "2h ago", "3d ago": the scale Remote access activity uses. */
export function jarvisRelativeTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** An invoke rejection as a sentence, without Electron's "Error invoking remote method" wrapper. */
export function jarvisErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sentence(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || "Jarvis did not answer");
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalized = `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?…]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
