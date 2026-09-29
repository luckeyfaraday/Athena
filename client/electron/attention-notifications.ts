import { Notification, type BrowserWindow } from "electron";

export type AttentionNotificationRequest = {
  title: string;
  body: string;
  // Echoed back to the renderer on click so it can open the terminal's workspace.
  workspace: string;
  sessionId: string;
};

export type AttentionActivatePayload = { workspace: string; sessionId: string };

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 240;

// Electron drops click handlers of notifications that get garbage-collected; hold them until they are dismissed.
const visibleNotifications = new Set<Notification>();

export function normalizeAttentionNotificationRequest(value: unknown): AttentionNotificationRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  const title = typeof request.title === "string" ? request.title.trim() : "";
  if (!title || typeof request.workspace !== "string" || typeof request.sessionId !== "string") return null;
  return {
    title: title.slice(0, MAX_TITLE_CHARS),
    body: typeof request.body === "string" ? request.body.trim().slice(0, MAX_BODY_CHARS) : "",
    workspace: request.workspace,
    sessionId: request.sessionId,
  };
}

/** Shows a native notification; clicking it brings Athena forward and asks the renderer to open that workspace. */
export function showAttentionNotification(window: BrowserWindow | null, request: AttentionNotificationRequest): boolean {
  if (!Notification.isSupported()) return false;
  // Athena plays its own attention sound.
  const notification = new Notification({ title: request.title, body: request.body, silent: true });
  const forget = () => visibleNotifications.delete(notification);
  visibleNotifications.add(notification);
  notification.on("click", () => {
    forget();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    const payload: AttentionActivatePayload = { workspace: request.workspace, sessionId: request.sessionId };
    window.webContents.send("attention:activate", payload);
  });
  notification.on("close", forget);
  notification.on("failed", forget);
  notification.show();
  return true;
}

/** Flashes the taskbar button (bounces the dock on macOS) until the window is focused again. */
export function flashWindowForAttention(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || window.isFocused()) return;
  window.flashFrame(true);
}

export function installAttentionWindowHandlers(window: BrowserWindow): void {
  window.on("focus", () => {
    if (!window.isDestroyed()) window.flashFrame(false);
  });
}
