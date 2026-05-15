import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Send } from "lucide-react";
import { desktop, type EmbeddedTerminalSession } from "../electron";

type Props = {
  session: EmbeddedTerminalSession;
};

export function EmbeddedChatTerminal({ session }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const [buffer, setBuffer] = useState("");
  const [prompt, setPrompt] = useState("");
  const [imageDropActive, setImageDropActive] = useState(false);

  useEffect(() => {
    let mounted = true;
    void desktop.getEmbeddedTerminalBuffer(session.id)
      .then((nextBuffer) => {
        if (mounted) setBuffer(nextBuffer);
      })
      .catch(() => undefined);

    const removeData = desktop.onEmbeddedTerminalData((payload) => {
      if (payload.id === session.id) setBuffer((current) => `${current}${payload.data}`);
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      if (payload.id === session.id) {
        setBuffer((current) => `${current}\n[process exited: ${payload.exitCode ?? "unknown"}]\n`);
      }
    });

    return () => {
      mounted = false;
      removeData();
      removeExit();
    };
  }, [session.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [buffer]);

  const transcript = useMemo(() => terminalTextToTranscript(buffer), [buffer]);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || session.status !== "running") return;
    setPrompt("");
    await desktop.writeEmbeddedTerminal(session.id, `${trimmed}\r`).catch(() => undefined);
  }

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
    setPrompt((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${pasted} `);
  }

  return (
    <div
      className={imageDropActive ? "embeddedChatTerminal imageDropActive" : "embeddedChatTerminal"}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="embeddedChatTranscript" ref={scrollRef}>
        {transcript ? (
          <article className="chatBubble assistant">
            <span>{session.title}</span>
            <pre>{transcript}</pre>
          </article>
        ) : (
          <div className="chatEmptyState">
            <strong>{session.status === "running" ? "Waiting for output" : "No transcript captured"}</strong>
            <span>{session.status === "running" ? "The same PTY session is running behind this chat view." : "This session is no longer running."}</span>
          </div>
        )}
      </div>
      <form className="embeddedChatComposer" onSubmit={submitPrompt}>
        <ImagePlus size={15} />
        <input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={session.status === "running" ? `Message ${session.title}` : "Session is not running"}
          disabled={session.status !== "running"}
        />
        <button type="submit" disabled={session.status !== "running" || prompt.trim().length === 0} title="Send message">
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}

function terminalTextToTranscript(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .trim()
    .slice(-12_000);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
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
