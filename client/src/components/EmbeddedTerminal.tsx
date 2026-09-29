import { DragEvent, memo, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import {
  getTerminalAppearance,
  subscribeTerminalAppearance,
  terminalFontFamily,
  type TerminalAppearance,
} from "../terminal-appearance";
import {
  desktop,
  type EmbeddedTerminalDataPayload,
  type EmbeddedTerminalExitPayload,
  type EmbeddedTerminalSession,
} from "../electron";
import { terminalUsesMouseWheelProtocol } from "../embedded-scroll";
import { subscribeTerminalWindowReturn } from "../terminal-lifecycle";
import "@xterm/xterm/css/xterm.css";

type Props = {
  session: EmbeddedTerminalSession;
  active?: boolean;
};

type FitRequest = { refresh?: boolean; focus?: boolean };
const EXIT_STREAM_RECOVERY_MS = 2_500;

let webglRendererAllowed: Promise<boolean> | null = null;
let webglModule: Promise<typeof import("@xterm/addon-webgl")> | null = null;

// The WebGL addon is only fetched and parsed when accelerated graphics can use
// it, keeping it off the startup path (and out of crash-safe mode entirely).
function loadWebglAddon(): Promise<typeof import("@xterm/addon-webgl")> {
  webglModule ??= import("@xterm/addon-webgl").catch((error) => {
    webglModule = null;
    throw error;
  });
  return webglModule;
}

// Wait for a bundled web font before xterm measures its cell size; measuring
// the fallback font first leaves glyphs misaligned until the next resize.
function whenTerminalFontReady(appearance: TerminalAppearance): Promise<void> {
  const family = terminalFontFamily(appearance.font).split(",")[0]?.trim();
  if (!family || typeof document.fonts?.load !== "function") return Promise.resolve();
  const spec = `${appearance.fontSize}px ${family}`;
  try {
    if (document.fonts.check(spec)) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, 1_500));
  return Promise.race([document.fonts.load(spec).then(() => undefined, () => undefined), timeout]);
}

// xterm's default DOM renderer re-lays out every changed row. When Chromium is
// running with GPU acceleration, the WebGL renderer draws the grid on the GPU
// instead, which is dramatically cheaper for busy agent TUIs. In crash-safe
// (software) graphics mode WebGL is unavailable, so keep the DOM renderer.
function allowWebglRenderer(): Promise<boolean> {
  webglRendererAllowed ??= desktop.getGraphicsStatus()
    .then((status) => status.mode === "accelerated")
    .catch(() => {
      // Don't pin a transient IPC failure for the whole session.
      webglRendererAllowed = null;
      return false;
    });
  return webglRendererAllowed;
}

// addon-webgl leaves its GL context for the garbage collector. Chromium caps
// live contexts per page, so release them eagerly when a pane unmounts.
function releaseWebglContexts(container: HTMLElement): void {
  for (const canvas of Array.from(container.querySelectorAll("canvas"))) {
    try {
      const context = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Best effort; the context is still reclaimed on GC.
    }
  }
}

// Only the session id and active flag drive this component; skip re-rendering
// every pane when the parent grid re-renders for unrelated state.
export const EmbeddedTerminal = memo(
  EmbeddedTerminalView,
  (previous, next) => previous.session.id === next.session.id && previous.active === next.active,
);

function EmbeddedTerminalView({ session, active = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const scheduleFitRef = useRef<((request?: FitRequest) => void) | null>(null);
  const dragDepthRef = useRef(0);
  const [imageDropActive, setImageDropActive] = useState(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialAppearance = getTerminalAppearance();
    const terminal = new Terminal({
      // Blinking cursors keep xterm repainting even when output is idle. Keep
      // this disabled in both accelerated and crash-safe graphics modes so a
      // workspace with several visible panes remains genuinely idle.
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily: terminalFontFamily(initialAppearance.font),
      fontSize: initialAppearance.fontSize,
      lineHeight: 1.2,
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
    terminalRef.current = terminal;
    fitRef.current = fit;
    let disposed = false;
    let opened = false;
    let webgl: WebglAddon | null = null;
    // Output that arrives before open() is parsed into the buffer and painted on open.
    const openTerminal = () => {
      if (disposed || opened) return;
      opened = true;
      terminal.open(container);
      scheduleFit({ refresh: true, focus: activeRef.current });
      void allowWebglRenderer().then(async (allowed) => {
        if (!allowed || disposed) return;
        let WebglAddonClass: typeof WebglAddon;
        try {
          WebglAddonClass = (await loadWebglAddon()).WebglAddon;
        } catch {
          return;
        }
        if (disposed) return;
        try {
          const addon = new WebglAddonClass();
          // Chromium caps live WebGL contexts per page; when one is reclaimed,
          // fall back to the DOM renderer for this pane.
          addon.onContextLoss(() => {
            addon.dispose();
            if (webgl === addon) webgl = null;
            // DOM and WebGL renderers measure cells differently; refit.
            if (!disposed) scheduleFit({ refresh: true });
          });
          terminal.loadAddon(addon);
          webgl = addon;
          scheduleFit({ refresh: true });
        } catch {
          // WebGL2 unavailable (e.g. blocklisted GPU); the DOM renderer stays active.
        }
      });
    };
    void whenTerminalFontReady(initialAppearance).then(openTerminal);
    const removeAppearance = subscribeTerminalAppearance((next) => {
      void whenTerminalFontReady(next).then(() => {
        if (disposed) return;
        terminal.options.fontFamily = terminalFontFamily(next.font);
        terminal.options.fontSize = next.fontSize;
        scheduleFit({ refresh: true });
      });
    });
    let writeInFlight = false;
    let attachResolved = false;
    let streamEpoch: string | null = null;
    let appliedSequence = 0;
    let queuedThroughSequence = 0;
    let attachGeneration = 0;
    let pendingExit: EmbeddedTerminalExitPayload | null = null;
    let exitQueued = false;
    let exitReattachAttempted = false;
    let exitRecoveryTimer = 0;
    const pendingWrites: Array<{
      data: string;
      epoch: string;
      sequence: number;
      acknowledge: boolean;
      reset: boolean;
      refresh: boolean;
    }> = [];
    const beforeAttach: EmbeddedTerminalDataPayload[] = [];
    let refreshAfterWrite = false;
    const enqueuePendingExit = () => {
      if (!pendingExit || exitQueued || !attachResolved) return;
      if (pendingExit.epoch && streamEpoch && pendingExit.epoch !== streamEpoch) {
        if (!exitReattachAttempted) {
          exitReattachAttempted = true;
          void attachStream();
          return;
        }
        // Main retains final output briefly after exit. If that state expired
        // before this view attached, the old exit cursor can never belong to
        // the replacement epoch. Render one explicit gap plus the exit once;
        // repeatedly reattaching here otherwise creates an infinite loop.
        const exit = pendingExit;
        pendingExit = null;
        exitQueued = true;
        if (exitRecoveryTimer) window.clearTimeout(exitRecoveryTimer);
        exitRecoveryTimer = 0;
        pendingWrites.push({
          data: `\r\n\x1b[33m[Athena: final terminal history expired before this view attached]\x1b[0m\r\n`
            + `\x1b[33m[process exited: ${exit.exitCode ?? "unknown"}]\x1b[0m\r\n`,
          epoch: streamEpoch,
          sequence: queuedThroughSequence,
          acknowledge: false,
          reset: false,
          refresh: true,
        });
        drainWrites();
        return;
      }
      const throughSequence = pendingExit.throughSequence ?? queuedThroughSequence;
      if (throughSequence > queuedThroughSequence) {
        if (!exitRecoveryTimer) {
          exitRecoveryTimer = window.setTimeout(() => {
            exitRecoveryTimer = 0;
            if (pendingExit && !exitQueued) void attachStream();
          }, EXIT_STREAM_RECOVERY_MS);
        }
        return;
      }
      const exit = pendingExit;
      pendingExit = null;
      exitQueued = true;
      if (exitRecoveryTimer) window.clearTimeout(exitRecoveryTimer);
      exitRecoveryTimer = 0;
      pendingWrites.push({
        data: `\r\n\x1b[33m[process exited: ${exit.exitCode ?? "unknown"}]\x1b[0m\r\n`,
        epoch: streamEpoch ?? "",
        sequence: throughSequence,
        acknowledge: false,
        reset: false,
        refresh: true,
      });
      drainWrites();
    };
    const drainWrites = () => {
      if (disposed || writeInFlight || pendingWrites.length === 0) return;
      const write = pendingWrites.shift();
      if (!write) return;
      writeInFlight = true;
      if (write.reset) terminal.reset();
      const complete = () => {
        // A reattach can replace the stream epoch while xterm is still
        // draining one old write. Its completion/ACK is harmless, but its old
        // sequence must not advance the cursor for the replacement epoch or
        // fresh payloads could be mistaken for duplicates.
        if (write.epoch === streamEpoch) {
          appliedSequence = Math.max(appliedSequence, write.sequence);
        }
        if (write.acknowledge) {
          desktop.ackEmbeddedTerminalData(session.id, write.epoch, write.sequence);
        }
        writeInFlight = false;
        refreshAfterWrite ||= write.refresh;
        if (refreshAfterWrite && pendingWrites.length === 0) {
          refreshAfterWrite = false;
          refreshTerminal(terminal);
        }
        drainWrites();
      };
      if (write.data) terminal.write(write.data, complete);
      else complete();
    };

    const enqueuePayload = (payload: EmbeddedTerminalDataPayload) => {
      if (!attachResolved) {
        beforeAttach.push(payload);
        return;
      }
      if (payload.epoch !== streamEpoch) {
        void attachStream();
        return;
      }
      if (payload.sequence <= appliedSequence) {
        desktop.ackEmbeddedTerminalData(session.id, payload.epoch, payload.sequence);
        return;
      }
      if (payload.sequence <= queuedThroughSequence) {
        // A retry can arrive while its first copy is still being parsed. The
        // first copy's completion callback will ACK it; never enqueue it twice.
        return;
      }
      if (!payload.reset && payload.fromSequence > queuedThroughSequence + 1) {
        // A sequence gap means this view cannot safely continue from its local
        // parser state. Rebase atomically from the rolling snapshot.
        void attachStream();
        return;
      }
      if (payload.reset) {
        pendingWrites.length = 0;
      }
      queuedThroughSequence = payload.sequence;
      pendingWrites.push({
        data: payload.data,
        epoch: payload.epoch,
        sequence: payload.sequence,
        acknowledge: true,
        reset: payload.reset,
        refresh: payload.reset,
      });
      enqueuePendingExit();
      drainWrites();
    };

    const attachStream = async () => {
      const generation = ++attachGeneration;
      attachResolved = false;
      const snapshot = await desktop.attachEmbeddedTerminalStream(session.id).catch(() => null);
      if (!snapshot || disposed || generation !== attachGeneration || terminalRef.current !== terminal) return;
      streamEpoch = snapshot.epoch;
      appliedSequence = 0;
      queuedThroughSequence = snapshot.throughSequence;
      pendingWrites.length = 0;
      pendingWrites.push({
        data: snapshot.buffer,
        epoch: snapshot.epoch,
        sequence: snapshot.throughSequence,
        acknowledge: false,
        reset: true,
        refresh: true,
      });
      attachResolved = true;
      const deferred = beforeAttach.splice(0);
      for (const payload of deferred) {
        if (payload.epoch === snapshot.epoch && payload.sequence <= snapshot.throughSequence) continue;
        enqueuePayload(payload);
      }
      enqueuePendingExit();
      drainWrites();
    };

    const dataDisposable = terminal.onData((data) => {
      void desktop.writeEmbeddedTerminal(session.id, data).catch(() => undefined);
    });

    const removeData = desktop.onEmbeddedTerminalDataFor(session.id, enqueuePayload, { ackMode: "manual" });
    void attachStream();
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      if (payload.id !== session.id || exitQueued) return;
      pendingExit = payload;
      exitReattachAttempted = false;
      enqueuePendingExit();
    });

    let fitFrame = 0;
    let pendingFitRequest: FitRequest = {};
    const scheduleFit = (request: FitRequest = {}) => {
      pendingFitRequest = {
        refresh: pendingFitRequest.refresh || request.refresh,
        focus: pendingFitRequest.focus || request.focus,
      };
      if (fitFrame) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = 0;
        const next = pendingFitRequest;
        pendingFitRequest = {};
        fitVisibleTerminal(container, terminal, fit, session.id, lastResizeRef);
        if (next.refresh) refreshTerminal(terminal);
        if (next.focus && activeRef.current && terminalMayTakeFocus(container)) terminal.focus();
      });
    };
    scheduleFitRef.current = scheduleFit;
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(container);
    scheduleFit({ refresh: true, focus: activeRef.current });
    const handleWindowReturn = () => scheduleFit({ refresh: true, focus: activeRef.current });
    const removeWindowReturn = subscribeTerminalWindowReturn(handleWindowReturn);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
      scheduleFit({ refresh: true });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const stopWheelPropagation = (event: WheelEvent) => {
      if (!terminalUsesMouseWheelProtocol(container)) return;
      event.stopPropagation();
    };
    container.addEventListener("wheel", stopWheelPropagation);

    return () => {
      disposed = true;
      attachGeneration += 1;
      if (exitRecoveryTimer) window.clearTimeout(exitRecoveryTimer);
      pendingWrites.length = 0;
      beforeAttach.length = 0;
      container.removeEventListener("wheel", stopWheelPropagation);
      removeWindowReturn();
      removeAppearance();
      if (fitFrame) window.cancelAnimationFrame(fitFrame);
      observer.disconnect();
      themeObserver.disconnect();
      removeData();
      removeExit();
      dataDisposable.dispose();
      linkDisposable.dispose();
      // Disposing the terminal also disposes loaded addons, including WebGL.
      if (webgl) releaseWebglContexts(container);
      webgl = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      scheduleFitRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    activeRef.current = active;
    scheduleFitRef.current?.({ refresh: true, focus: active });
  }, [active]);

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
  lastResizeRef: { current: { cols: number; rows: number } | null },
) {
  if (!hasUsableTerminalSize(container)) return;
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

// Panes focus themselves when they mount, become active, or the window comes
// back. Never do that under an open dialog (the palette, a rename) or out of
// a text field the user is typing in, or keystrokes meant for it would land
// in an agent's terminal. Moving focus between terminals is fine.
function terminalMayTakeFocus(container: HTMLElement): boolean {
  if (document.querySelector('[aria-modal="true"]')) return false;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === document.body || container.contains(focused)) return true;
  if (focused.closest(".xterm")) return true;
  const typing = focused instanceof HTMLInputElement
    || focused instanceof HTMLTextAreaElement
    || focused instanceof HTMLSelectElement
    || focused.isContentEditable;
  return !typing;
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

// The terminal follows the active theme: every theme defines a full 16-color
// ANSI palette (styles/themes.css) tuned for its own background.
function readTerminalTheme(): ITheme {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  const accent = value("--accent", "#60a5fa");
  const background = value("--terminal", "#03050a");
  return {
    background,
    foreground: value("--text", "#dbeafe"),
    cursor: accent,
    cursorAccent: background,
    selectionBackground: colorMix(accent, 0.3),
    selectionInactiveBackground: colorMix(accent, 0.16),
    black: value("--ansi-black", "#020617"),
    red: value("--ansi-red", "#fb7185"),
    green: value("--ansi-green", "#22c55e"),
    yellow: value("--ansi-yellow", "#f59e0b"),
    blue: value("--ansi-blue", "#60a5fa"),
    magenta: value("--ansi-magenta", "#a78bfa"),
    cyan: value("--ansi-cyan", "#22d3ee"),
    white: value("--ansi-white", "#e2e8f0"),
    brightBlack: value("--ansi-bright-black", "#64748b"),
    brightRed: value("--ansi-bright-red", "#fda4af"),
    brightGreen: value("--ansi-bright-green", "#86efac"),
    brightYellow: value("--ansi-bright-yellow", "#fcd34d"),
    brightBlue: value("--ansi-bright-blue", "#93c5fd"),
    brightMagenta: value("--ansi-bright-magenta", "#c4b5fd"),
    brightCyan: value("--ansi-bright-cyan", "#67e8f9"),
    brightWhite: value("--ansi-bright-white", "#f8fafc"),
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
