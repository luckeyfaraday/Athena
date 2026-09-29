export type WorkspaceAttentionKind = "action" | "update";

// Why a terminal asked for attention (decided in the main process, see electron/terminal-attention.ts).
export type TerminalAttentionReason =
  | "approval"
  | "question"
  | "trust"
  | "yes-no"
  | "turn-complete"
  | "notification"
  | "bell"
  | "exit";

export type TerminalAttentionEvent = {
  id: string;
  kind: WorkspaceAttentionKind;
  reason: TerminalAttentionReason;
  message: string | null;
};

export type WorkspaceAttention = {
  kind: WorkspaceAttentionKind;
  count: number;
};

export function mergeWorkspaceAttention(
  current: WorkspaceAttention | undefined,
  kind: WorkspaceAttentionKind,
): WorkspaceAttention {
  if (!current) return { kind, count: 1 };
  return {
    kind: current.kind === "action" || kind === "action" ? "action" : "update",
    count: Math.min(current.count + 1, 9),
  };
}

// "all": needs input and finished; "action": needs input only; "off": workspace tab badges only.
export type NotificationLevel = "all" | "action" | "off";
export type AttentionSoundStyle = "chime" | "soft" | "digital" | "none";

export type NotificationPreferences = {
  level: NotificationLevel;
  sound: AttentionSoundStyle;
  // 0..1
  volume: number;
  // Desktop notifications while Athena is in the background.
  desktop: boolean;
};

export const defaultNotificationPreferences: NotificationPreferences = {
  level: "all",
  sound: "chime",
  volume: 0.6,
  desktop: true,
};

const notificationLevels: readonly NotificationLevel[] = ["all", "action", "off"];
const soundStyles: readonly AttentionSoundStyle[] = ["chime", "soft", "digital", "none"];

/** Reads stored preferences, keeping defaults for anything missing or invalid. Null when nothing usable is stored. */
export function parseNotificationPreferences(value: string | null): NotificationPreferences | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stored = parsed as Record<string, unknown>;
  const defaults = defaultNotificationPreferences;
  return {
    level: notificationLevels.includes(stored.level as NotificationLevel) ? stored.level as NotificationLevel : defaults.level,
    sound: soundStyles.includes(stored.sound as AttentionSoundStyle) ? stored.sound as AttentionSoundStyle : defaults.sound,
    volume: typeof stored.volume === "number" && Number.isFinite(stored.volume)
      ? Math.min(1, Math.max(0, stored.volume))
      : defaults.volume,
    desktop: typeof stored.desktop === "boolean" ? stored.desktop : defaults.desktop,
  };
}

export function serializeNotificationPreferences(preferences: NotificationPreferences): string {
  return JSON.stringify(preferences);
}

export type AttentionContext = {
  // Workspace of the terminal that asked, null when the terminal is unknown (already closed).
  sessionWorkspaceKey: string | null;
  activeWorkspaceKey: string;
  windowFocused: boolean;
  commandRoomVisible: boolean;
};

export type AttentionDelivery = {
  badge: boolean;
  sound: boolean;
  desktop: boolean;
  flash: boolean;
};

const noDelivery: AttentionDelivery = { badge: false, sound: false, desktop: false, flash: false };

/**
 * How to surface an attention event. Nothing while the user is looking at that terminal's workspace; a tab badge for
 * other workspaces; sound, a desktop notification and a flashing taskbar button when Athena is in the background.
 */
export function attentionDelivery(
  kind: WorkspaceAttentionKind,
  context: AttentionContext,
  preferences: NotificationPreferences,
): AttentionDelivery {
  if (!context.sessionWorkspaceKey) return noDelivery;
  const inActiveWorkspace = context.sessionWorkspaceKey === context.activeWorkspaceKey;
  if (inActiveWorkspace && context.windowFocused && context.commandRoomVisible) return noDelivery;
  const badge = !inActiveWorkspace;
  const alert = preferences.level === "all" || (preferences.level === "action" && kind === "action");
  if (!alert) return { ...noDelivery, badge };
  return {
    badge,
    sound: preferences.sound !== "none" && preferences.volume > 0,
    desktop: preferences.desktop && !context.windowFocused,
    flash: kind === "action" && !context.windowFocused,
  };
}

/** One line naming the terminal and what it needs, for desktop notifications. */
export function attentionHeadline(title: string, event: Pick<TerminalAttentionEvent, "kind" | "reason" | "message">): string {
  switch (event.reason) {
    case "approval":
      return `${title} is waiting for your approval`;
    case "question":
      return `${title} has a question for you`;
    case "trust":
      return `${title} is asking to trust this folder`;
    case "yes-no":
      return `${title} is waiting for a yes/no answer`;
    case "turn-complete":
      return `${title} finished`;
    case "exit":
      return event.message ? `${title} exited (${event.message.replace(/^exited with /i, "")})` : `${title} exited`;
    case "bell":
      return `${title} rang the terminal bell`;
    case "notification":
      return event.kind === "action" ? `${title} needs you` : `${title} sent a notification`;
  }
}
