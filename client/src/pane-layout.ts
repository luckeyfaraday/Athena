export const MIN_TERMINAL_PANE_HEIGHT = 205;

export function clampTerminalPaneHeight(value: number, availableHeight: number): number {
  const finiteValue = Number.isFinite(value) ? value : MIN_TERMINAL_PANE_HEIGHT;
  const finiteAvailable = Number.isFinite(availableHeight) ? availableHeight : finiteValue;
  const maximum = Math.max(MIN_TERMINAL_PANE_HEIGHT, Math.floor(finiteAvailable));
  return Math.min(maximum, Math.max(MIN_TERMINAL_PANE_HEIGHT, Math.round(finiteValue)));
}

export function reconcileTerminalPaneHeights(
  current: Record<string, number>,
  sessionIds: readonly string[],
  resetForPaneSetChange: boolean,
): Record<string, number> {
  if (resetForPaneSetChange) return {};
  const sessionIdSet = new Set(sessionIds);
  const next = Object.fromEntries(Object.entries(current).filter(([id]) => sessionIdSet.has(id)));
  if (Object.keys(next).length === Object.keys(current).length) return current;
  return next;
}

export function terminalFocusAfterCollapse(
  collapsingId: string,
  activeId: string | null,
  orderedVisibleIds: readonly string[],
  alreadyCollapsedIds: ReadonlySet<string>,
): string | null {
  if (activeId !== collapsingId) return activeId;
  const index = orderedVisibleIds.indexOf(collapsingId);
  const candidates = [
    ...orderedVisibleIds.slice(Math.max(0, index + 1)),
    ...orderedVisibleIds.slice(0, Math.max(0, index)),
  ];
  return candidates.find((id) => id !== collapsingId && !alreadyCollapsedIds.has(id)) ?? null;
}
