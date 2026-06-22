export const CHAT_SCROLL_STICK_THRESHOLD_PX = 48;

export function isNearScrollBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = CHAT_SCROLL_STICK_THRESHOLD_PX,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function terminalUsesMouseWheelProtocol(container: ParentNode | null | undefined): boolean {
  return Boolean(container?.querySelector(".xterm.enable-mouse-events"));
}