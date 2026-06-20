import { DragEvent, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import { desktop, type EmbeddedTerminalSession } from "../electron";
import "@xterm/xterm/css/xterm.css";

type Props = {
  session: EmbeddedTerminalSession;
  active?: boolean;
};

const MAX_PENDING_XTERM_OUTPUT_CHARS = 64_000;

export function EmbeddedTerminal({ session, active = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const dragDepthRef = useRef(0);
  const [imageDropActive, setImageDropActive] = useState(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'Cascadia Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 10,
      lineHeight: 1.25,
      scrollback: 2000,
      convertEol: false,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const linkDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        callback(detectExternalLinks(terminal, bufferLineNumber));
      },
    });
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    fitVisibleTerminal(container, terminal, fit, session.id, activeRef.current, lastResizeRef);
    if (activeRef.current) terminal.focus();

    let disposed = false;
    let writeInFlight = false;
    let pendingWrite = "";
    let refreshAfterWrite = false;
    const drainWrites = () => {
      if (disposed || writeInFlight || !pendingWrite) return;
      const data = pendingWrite;
      pendingWrite = "";
      writeInFlight = true;
      terminal.write(data, () => {
        writeInFlight = false;
        if (refreshAfterWrite && !pendingWrite) {
          refreshAfterWrite = false;
          refreshTerminal(terminal);
        }
        drainWrites();
      });
    };
    const enqueueWrite = (data: string, refresh = false) => {
      const combined = `${pendingWrite}${data}`;
      pendingWrite = combined.length > MAX_PENDING_XTERM_OUTPUT_CHARS
        ? combined.slice(-MAX_PENDING_XTERM_OUTPUT_CHARS)
        : combined;
      refreshAfterWrite ||= refresh;
      drainWrites();
    };

    void desktop.getEmbeddedTerminalBuffer(session.id)
      .then((buffer) => {
        if (!buffer || terminalRef.current !== terminal) return;
        enqueueWrite(buffer, true);
      })
      .catch(() => undefined);

    const dataDisposable = terminal.onData((data) => {
      void desktop.writeEmbeddedTerminal(session.id, data).catch(() => undefined);
    });

    const removeData = desktop.onEmbeddedTerminalData((payload) => {
      if (payload.id === session.id) enqueueWrite(payload.data);
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      if (payload.id === session.id) terminal.writeln(`\r\n\x1b[33m[process exited: ${payload.exitCode ?? "unknown"}]\x1b[0m`);
    });

    const resize = () => {
      fitVisibleTerminal(container, terminal, fit, session.id, activeRef.current, lastResizeRef);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.setTimeout(resize, 50);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-loaded"] });

    return () => {
      disposed = true;
      pendingWrite = "";
      observer.disconnect();
      themeObserver.disconnect();
      removeData();
      removeExit();
      dataDisposable.dispose();
      linkDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    // Force PTY resize on next fit so the backend re-emits SIGWINCH and TUI apps redraw
    // after tab/workspace switches that left the pane visually stale.
    lastResizeRef.current = null;
    const refit = () => {
      const container = containerRef.current;
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!container || !terminal || !fit) return;
      fitVisibleTerminal(container, terminal, fit, session.id, true, lastResizeRef);
      refreshTerminal(terminal);
      terminal.focus();
    };
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(refit);
    });
    const timers = [80, 240].map((delay) => window.setTimeout(refit, delay));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [active, session.id]);

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setImageDropActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setImageDropActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setImageDropActive(false);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setImageDropActive(false);

    const images = Array.from(event.dataTransfer.files).filter(isImageFile);
    if (images.length === 0) return;
    const paths = await desktop.getDroppedFilePaths(images).catch(() => []);
    const pasted = paths.filter(Boolean).map(quoteTerminalPath).join(" ");
    if (!pasted) return;
    terminalRef.current?.focus();
    void desktop.writeEmbeddedTerminal(session.id, `${pasted} `).catch(() => undefined);
  }

  return (
    <div
      className={imageDropActive ? "embeddedTerminalMount imageDropActive" : "embeddedTerminalMount"}
      ref={containerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    />
  );
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function detectExternalLinks(terminal: Terminal, bufferLineNumber: number): ILink[] | undefined {
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  if (!line) return undefined;

  const text = line.translateToString(true);
  const links: ILink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const url = trimTerminalUrl(raw);
    if (!url || match.index === undefined) continue;

    const startColumn = match.index + 1;
    const endColumn = startColumn + url.length - 1;
    links.push({
      range: {
        start: { x: startColumn, y: bufferLineNumber },
        end: { x: endColumn, y: bufferLineNumber },
      },
      text: url,
      decorations: { pointerCursor: true, underline: true },
      activate: (_event, value) => {
        void desktop.openExternalUrl(value).catch(() => undefined);
      },
    });
  }
  return links.length > 0 ? links : undefined;
}

function trimTerminalUrl(value: string): string {
  let trimmed = value.replace(/[.,;:!?]+$/g, "");
  while (/[)\]}]$/.test(trimmed) && hasUnmatchedClosingBracket(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function hasUnmatchedClosingBracket(value: string): boolean {
  const last = value.at(-1);
  if (!last) return false;
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const opener = pairs[last];
  if (!opener) return false;
  return countChars(value, last) > countChars(value, opener);
}

function countChars(value: string, char: string): number {
  return Array.from(value).filter((item) => item === char).length;
}

function fitVisibleTerminal(
  container: HTMLDivElement,
  terminal: Terminal,
  fit: FitAddon,
  sessionId: string,
  active: boolean,
  lastResizeRef: { current: { cols: number; rows: number } | null },
) {
  if (!active || !hasUsableTerminalSize(container)) return;
  try {
    fit.fit();
    const nextSize = { cols: terminal.cols, rows: terminal.rows };
    const lastSize = lastResizeRef.current;
    if (lastSize?.cols === nextSize.cols && lastSize.rows === nextSize.rows) return;
    lastResizeRef.current = nextSize;
    void desktop.resizeEmbeddedTerminal(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
  } catch {
    // xterm fit can throw while the pane is temporarily hidden during workspace changes.
  }
}

function hasUsableTerminalSize(container: HTMLDivElement): boolean {
  const rect = container.getBoundingClientRect();
  return rect.width >= 160 && rect.height >= 80;
}

function refreshTerminal(terminal: Terminal): void {
  const lastRow = Math.max(0, terminal.rows - 1);
  try {
    terminal.refresh(0, lastRow);
  } catch {
    // refresh can throw if the renderer is mid-teardown or the pane was hidden during the call.
  }
}

function hasImageFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"))
    || Array.from(dataTransfer.files).some(isImageFile);
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name);
}

function quoteTerminalPath(path: string): string {
  return `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

function readTerminalTheme(): ITheme {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  const accent = value("--accent", value("--blue", "#60a5fa"));
  return {
    background: value("--terminal", "#03050a"),
    foreground: value("--text", "#dbeafe"),
    cursor: accent,
    selectionBackground: colorMix(accent, 0.28),
    black: "#020617",
    blue: value("--blue", "#60a5fa"),
    cyan: accent,
    green: value("--green", "#22c55e"),
    magenta: value("--violet", "#a78bfa"),
    red: value("--red", "#fb7185"),
    white: value("--text", "#e2e8f0"),
    yellow: value("--orange", "#f59e0b"),
  };
}

function colorMix(color: string, alpha: number): string {
  const trimmed = color.trim();
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) {
    const channels = trimmed.match(/^rgba?\(([^)]+)\)$/i)?.[1]?.split(",").slice(0, 3).map((part) => part.trim());
    return channels?.length === 3 ? `rgba(${channels.join(", ")}, ${alpha})` : `rgba(96, 165, 250, ${alpha})`;
  }
  const raw = hex[1].length === 3
    ? hex[1].split("").map((char) => `${char}${char}`).join("")
    : hex[1];
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
