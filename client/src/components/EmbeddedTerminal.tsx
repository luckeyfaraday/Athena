import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { desktop, type EmbeddedTerminalSession } from "../electron";
import "@xterm/xterm/css/xterm.css";

type Props = {
  session: EmbeddedTerminalSession;
  active?: boolean;
};

export function EmbeddedTerminal({ session, active = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'Cascadia Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 10000,
      convertEol: true,
      theme: {
        background: "#03050a",
        foreground: "#dbeafe",
        cursor: "#22d3ee",
        selectionBackground: "rgba(34, 211, 238, 0.28)",
        black: "#020617",
        blue: "#60a5fa",
        cyan: "#22d3ee",
        green: "#22c55e",
        magenta: "#a78bfa",
        red: "#fb7185",
        white: "#e2e8f0",
        yellow: "#f59e0b",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const dataDisposable = terminal.onData((data) => {
      void desktop.writeEmbeddedTerminal(session.id, data).catch(() => undefined);
    });

    const removeData = desktop.onEmbeddedTerminalData((payload) => {
      if (payload.id === session.id) terminal.write(payload.data);
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      if (payload.id === session.id) terminal.writeln(`\r\n\x1b[33m[process exited: ${payload.exitCode ?? "unknown"}]\x1b[0m`);
    });

    const resize = () => {
      try {
        fit.fit();
        void desktop.resizeEmbeddedTerminal(session.id, terminal.cols, terminal.rows).catch(() => undefined);
      } catch {
        // xterm fit can throw while the pane is temporarily hidden.
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.setTimeout(resize, 50);

    return () => {
      observer.disconnect();
      removeData();
      removeExit();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) return;
    window.setTimeout(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }, 30);
  }, [active]);

  return <div className="embeddedTerminalMount" ref={containerRef} />;
}
