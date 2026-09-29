import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { rankCommands } from "../fuzzy";
import { maxDisplayedPaletteRecents, readPaletteRecents, recordPaletteRecent } from "../palette-recents";
import "./command-palette.css";

export type PaletteCommand = {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  keywords?: string[];
  keys?: string[];
  icon?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  // Called when this item becomes highlighted (live theme preview).
  preview?: () => void;
  run: () => void | Promise<void>;
};

type CommandPaletteProps = {
  open: boolean;
  commands: PaletteCommand[];
  // Applied each time the palette opens, e.g. "launch ".
  initialQuery?: string;
  placeholder?: string;
  // false: dismissed (Esc or backdrop); true: a command ran.
  onClose: (ran: boolean) => void;
  // The highlight left a previewing command for one without a preview.
  onPreviewReset?: () => void;
};

type PaletteRow = {
  key: string;
  command: PaletteCommand;
  titleIndices: readonly number[];
  showGroup: boolean;
};

type PaletteSection = { id: string; label: string | null; rows: PaletteRow[] };

const maxResults = 100;
const pageStep = 8;
const noIndices: readonly number[] = [];

export function CommandPalette(props: CommandPaletteProps) {
  // Mount the dialog only while open, so a closed palette costs nothing and
  // every opening starts fresh (query, highlight, recents).
  if (!props.open) return null;
  return <CommandPaletteDialog {...props} />;
}

function CommandPaletteDialog({
  commands,
  initialQuery = "",
  placeholder = "Search commands, agents, workspaces, themes…",
  onClose,
  onPreviewReset,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [recents] = useState(readPaletteRecents);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const sections = useMemo(() => buildSections(query, commands, recents), [query, commands, recents]);
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const searching = query.trim().length > 0;
  const commandCount = useMemo(() => new Set(commands.map((command) => command.id)).size, [commands]);

  const matchedIndex = activeKey == null ? -1 : rows.findIndex((row) => row.key === activeKey);
  const activeIndex = rows.length === 0 ? -1 : Math.max(0, matchedIndex);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : null;
  const activeCommandId = activeRow?.command.id ?? null;
  const activeRowRef = useRef(activeRow);
  activeRowRef.current = activeRow;

  // Focus the input on open; hand focus back on close unless something else
  // (a dialog a command opened, say) has taken it. A layout-effect cleanup
  // runs before the next commit's autofocus, so it never steals from it.
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input = inputRef.current;
    if (input) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    return () => {
      const current = document.activeElement;
      const paletteHasFocus = !current || current === document.body || Boolean(current.closest(".commandPaletteBackdrop"));
      if (paletteHasFocus && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Preview only a highlight the user chose (arrow keys, pointer) or typed
  // toward: merely opening the palette on a recent theme must not repaint the app.
  const deliberate = activeKey != null || searching;
  const previewingRef = useRef(false);
  useEffect(() => {
    const command = activeRowRef.current?.command;
    if (command?.preview && deliberate) {
      previewingRef.current = true;
      command.preview();
    } else if (previewingRef.current) {
      previewingRef.current = false;
      onPreviewReset?.();
    }
  }, [activeCommandId, deliberate]);

  useLayoutEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function updateQuery(value: string) {
    setQuery(value);
    setActiveKey(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  }

  function select(index: number) {
    const row = rows[index];
    if (row && row.key !== activeRow?.key) setActiveKey(row.key);
  }

  function move(delta: number, wrap: boolean) {
    if (rows.length === 0) return;
    const target = activeIndex + delta;
    select(wrap
      ? ((target % rows.length) + rows.length) % rows.length
      : Math.min(rows.length - 1, Math.max(0, target)));
  }

  function run(row: PaletteRow | null) {
    if (!row || row.command.disabled || closingRef.current) return;
    closingRef.current = true;
    recordPaletteRecent(row.command.id);
    onClose(true);
    try {
      void Promise.resolve(row.command.run()).catch((error: unknown) => {
        console.error(`Command "${row.command.id}" failed`, error);
      });
    } catch (error) {
      console.error(`Command "${row.command.id}" failed`, error);
    }
  }

  function dismiss() {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1, true);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1, true);
        break;
      case "PageDown":
        event.preventDefault();
        move(pageStep, false);
        break;
      case "PageUp":
        event.preventDefault();
        move(-pageStep, false);
        break;
      case "Home":
      case "End":
        // Plain Home/End keep moving the caret in the input.
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          select(event.key === "Home" ? 0 : rows.length - 1);
        }
        break;
      case "Enter":
        event.preventDefault();
        run(activeRow);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        break;
      case "Tab":
        event.preventDefault();
        break;
    }
  }

  // Keep focus (and the caret) in the input while clicking rows or chrome.
  function keepInputFocus(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target !== inputRef.current) event.preventDefault();
  }

  let rowIndex = 0;
  return (
    <div
      className="commandPaletteBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        dismiss();
      }}
    >
      <div
        className="commandPalette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
        onMouseDown={keepInputFocus}
      >
        <div className="commandPaletteSearch">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeRow ? optionId(activeIndex) : undefined}
            onChange={(event) => updateQuery(event.target.value)}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="commandPaletteList" id={listId} role="listbox" aria-label="Commands" ref={listRef}>
          {sections.map((section) => {
            const headingId = `${baseId}-${section.id}`;
            const items = section.rows.map((row) => {
              const index = rowIndex;
              rowIndex += 1;
              return (
                <PaletteOption
                  key={row.key}
                  id={optionId(index)}
                  index={index}
                  row={row}
                  active={index === activeIndex}
                  onHover={() => select(index)}
                  onRun={() => run(row)}
                />
              );
            });
            if (!section.label) return <Fragment key={section.id}>{items}</Fragment>;
            return (
              <div key={section.id} className="commandPaletteGroup" role="group" aria-labelledby={headingId}>
                <div className="commandPaletteHeading" id={headingId} role="presentation">{section.label}</div>
                {items}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <div className="commandPaletteEmpty" role="status">
            {searching ? <>No commands match “{query.trim()}”</> : "No commands available"}
          </div>
        )}
        <div className="commandPaletteFooter" aria-hidden="true">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> navigate</span>
          <span><kbd className="kbd">↵</kbd> run</span>
          <span><kbd className="kbd">esc</kbd> close</span>
          <span className="commandPaletteCount">
            {searching ? `${rows.length} ${rows.length === 1 ? "result" : "results"}` : `${commandCount} commands`}
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteOption({
  id,
  index,
  row,
  active,
  onHover,
  onRun,
}: {
  id: string;
  index: number;
  row: PaletteRow;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const { command } = row;
  const detail = command.disabled && command.disabledReason ? command.disabledReason : command.subtitle;
  return (
    <div
      id={id}
      data-index={index}
      role="option"
      aria-selected={active}
      aria-disabled={command.disabled || undefined}
      title={command.disabled ? command.disabledReason : undefined}
      className={[
        "commandPaletteItem",
        active ? "active" : "",
        command.disabled ? "disabled" : "",
      ].filter(Boolean).join(" ")}
      // mousemove, not mouseenter: a list scrolled by the keyboard must not
      // re-highlight whatever row slides under a resting pointer.
      onMouseMove={active ? undefined : onHover}
      onClick={onRun}
    >
      <span className="commandPaletteIcon" aria-hidden="true">{command.icon}</span>
      <span className="commandPaletteText">
        <span className="commandPaletteTitle"><HighlightedText text={command.title} indices={row.titleIndices} /></span>
        {detail ? <span className="commandPaletteSubtitle">{detail}</span> : null}
      </span>
      {(row.showGroup || command.keys?.length) ? (
        <span className="commandPaletteMeta">
          {row.showGroup ? <span className="commandPaletteTag">{command.group}</span> : null}
          {command.keys?.length ? (
            <span className="kbdGroup">
              {command.keys.map((key, keyIndex) => <kbd key={`${key}-${keyIndex}`} className="kbd">{key}</kbd>)}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function HighlightedText({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  while (i < indices.length) {
    const start = indices[i];
    let end = start;
    while (i + 1 < indices.length && indices[i + 1] === end + 1) {
      i += 1;
      end += 1;
    }
    if (start >= text.length) break;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={start}>{text.slice(start, end + 1)}</mark>);
    cursor = end + 1;
    i += 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function buildSections(query: string, commands: readonly PaletteCommand[], recents: readonly string[]): PaletteSection[] {
  if (query.trim()) {
    const seen = new Set<string>();
    const rows: PaletteRow[] = [];
    for (const ranked of rankCommands(query, commands, maxResults)) {
      if (seen.has(ranked.command.id)) continue;
      seen.add(ranked.command.id);
      rows.push({ key: `cmd:${ranked.command.id}`, command: ranked.command, titleIndices: ranked.titleIndices, showGroup: true });
    }
    return [{ id: "results", label: null, rows }];
  }

  const byId = new Map<string, PaletteCommand>();
  for (const command of commands) if (!byId.has(command.id)) byId.set(command.id, command);

  const sections: PaletteSection[] = [];
  const recentRows: PaletteRow[] = [];
  for (const id of recents) {
    const command = byId.get(id);
    if (!command) continue;
    recentRows.push({ key: `recent:${id}`, command, titleIndices: noIndices, showGroup: true });
    if (recentRows.length >= maxDisplayedPaletteRecents) break;
  }
  if (recentRows.length > 0) sections.push({ id: "recent", label: "Recent", rows: recentRows });

  const groups = new Map<string, PaletteRow[]>();
  for (const command of byId.values()) {
    const rows = groups.get(command.group) ?? [];
    rows.push({ key: `cmd:${command.id}`, command, titleIndices: noIndices, showGroup: false });
    groups.set(command.group, rows);
  }
  let groupIndex = 0;
  for (const [label, rows] of groups) {
    sections.push({ id: `group-${groupIndex}`, label, rows });
    groupIndex += 1;
  }
  return sections;
}
