import { DragEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Send, TerminalSquare } from "lucide-react";
import { desktop, type EmbeddedTerminalSession } from "../electron";

type Props = {
  session: EmbeddedTerminalSession;
};

const MAX_CHAT_BUFFER_CHARS = 80_000;
const MAX_OUTPUT_CHARS = 14_000;
const MAX_OUTPUT_BLOCKS = 8;

type ChatBlock = {
  id: string;
  role: "user" | "assistant" | "status";
  label: string;
  text: string;
};

type SentPromptBlock = ChatBlock & {
  marker: number;
};

export function EmbeddedChatTerminal({ session }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const [buffer, setBuffer] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sentPrompts, setSentPrompts] = useState<SentPromptBlock[]>([]);
  const [imageDropActive, setImageDropActive] = useState(false);

  useEffect(() => {
    let mounted = true;
    void desktop.getEmbeddedTerminalBuffer(session.id)
      .then((nextBuffer) => {
        if (mounted) setBuffer(capChatBuffer(nextBuffer));
      })
      .catch(() => undefined);

    const removeData = desktop.onEmbeddedTerminalData((payload) => {
      if (payload.id === session.id) setBuffer((current) => capChatBuffer(`${current}${payload.data}`));
    });
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      if (payload.id === session.id) {
        setBuffer((current) => capChatBuffer(`${current}\n[process exited: ${payload.exitCode ?? "unknown"}]\n`));
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

  const outputBlocks = useMemo(() => terminalTextToBlocks(buffer, session, sentPrompts.map((block) => block.marker)), [buffer, session, sentPrompts]);
  const chatBlocks = useMemo(() => interleaveChatTurns(outputBlocks, sentPrompts).slice(-12), [outputBlocks, sentPrompts]);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || session.status !== "running") return;
    const marker = buffer.length;
    setPrompt("");
    setSentPrompts((current) => [
      ...current.slice(-4),
      {
        id: `prompt-${Date.now()}`,
        role: "user",
        label: "You",
        text: trimmed,
        marker,
      },
    ]);
    await writePromptToSession(session, trimmed);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
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
      <div className="embeddedChatStatus">
        <span className={`chatStatusDot ${session.status}`} />
        <strong>{session.status === "running" ? "Running" : "Exited"}</strong>
        <em>{session.kind}{session.pid ? ` · PID ${session.pid}` : ""}</em>
      </div>
      <div className="embeddedChatTranscript" ref={scrollRef}>
        {chatBlocks.length ? (
          chatBlocks.map((block) => (
            <article key={block.id} className={`chatBubble ${block.role}`}>
              <span>
                {block.role === "status" ? <AlertTriangle size={13} /> : block.role === "assistant" ? <TerminalSquare size={13} /> : null}
                {block.label}
              </span>
              <pre>{block.text}</pre>
            </article>
          ))
        ) : (
          <div className="chatEmptyState">
            <strong>{session.status === "running" ? "Waiting for assistant output" : "No useful transcript captured"}</strong>
            <span>{session.status === "running" ? "Startup chrome and control/status lines are hidden in chat mode." : "Terminal output did not contain readable assistant content."}</span>
          </div>
        )}
      </div>
      <form className="embeddedChatComposer" onSubmit={submitPrompt}>
        <ImagePlus size={15} />
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={session.status === "running" ? `Message ${session.title}` : "Session is not running"}
          disabled={session.status !== "running"}
          rows={1}
        />
        <button type="submit" disabled={session.status !== "running" || prompt.trim().length === 0} title="Send message">
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}

async function writePromptToSession(session: EmbeddedTerminalSession, prompt: string): Promise<void> {
  if (session.kind === "codex") {
    await desktop.writeEmbeddedTerminal(session.id, prompt).catch(() => undefined);
    await delay(120);
    await desktop.writeEmbeddedTerminal(session.id, "\r").catch(() => undefined);
    return;
  }
  await desktop.writeEmbeddedTerminal(session.id, `${prompt}\r`).catch(() => undefined);
}

function terminalTextToBlocks(value: string, session: EmbeddedTerminalSession, turnMarkers: number[]): ChatBlock[] {
  const segments = splitBufferIntoTurnSegments(value, turnMarkers);
  const blocks: ChatBlock[] = [];

  segments.forEach((segment, segmentIndex) => {
    const transcript = normalizeTerminalText(segment);
    if (!transcript) return;

    const lines = transcript.split("\n");
    const statusLines = lines.filter(isStatusLine).slice(-2);
    const body = lines
      .filter((line) => !isStatusLine(line))
      .filter((line) => !isPromptEchoLine(line))
      .filter((line) => !isThinkingLine(line))
      .join("\n")
      .trim();

    statusLines.forEach((line, index) => {
      blocks.push({
        id: `status-${segmentIndex}-${index}-${line}`,
        role: "status",
        label: "Status",
        text: line,
      });
    });

    const chunks = splitOutputIntoChunks(body);
    chunks.forEach((chunk, index) => {
      blocks.push({
        id: `output-${segmentIndex}-${index}-${chunk.slice(0, 32)}`,
        role: "assistant",
        label: session.title,
        text: chunk,
      });
    });
  });

  return blocks.slice(-MAX_OUTPUT_BLOCKS);
}

function interleaveChatTurns(outputBlocks: ChatBlock[], sentPrompts: SentPromptBlock[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const outputBySegment = new Map<number, ChatBlock[]>();

  for (const block of outputBlocks) {
    const match = /^output-(\d+)-|^status-(\d+)-/.exec(block.id);
    const segment = Number(match?.[1] ?? match?.[2] ?? 0);
    outputBySegment.set(segment, [...(outputBySegment.get(segment) ?? []), block]);
  }

  blocks.push(...(outputBySegment.get(0) ?? []));
  sentPrompts.forEach((promptBlock, index) => {
    blocks.push(promptBlock);
    blocks.push(...(outputBySegment.get(index + 1) ?? []));
  });

  for (const [segment, segmentBlocks] of outputBySegment) {
    if (segment > sentPrompts.length) blocks.push(...segmentBlocks);
  }
  return blocks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function splitBufferIntoTurnSegments(value: string, markers: number[]): string[] {
  const validMarkers = [...new Set(markers)]
    .filter((marker) => marker > 0 && marker < value.length)
    .sort((left, right) => left - right);
  if (validMarkers.length === 0) return [value];

  const segments: string[] = [];
  let start = 0;
  for (const marker of validMarkers) {
    const segment = value.slice(start, marker);
    if (segment.trim()) segments.push(segment);
    start = marker;
  }
  const last = value.slice(start);
  if (last.trim()) segments.push(last);
  return segments;
}

function normalizeTerminalText(value: string): string {
  const lines = stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r+/g, "\n")
    .split("\n")
    .map(cleanTerminalLine)
    .map(stripDecorativeBorders);
  const clean = filterMeaningfulChatLines(lines)
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .trim()
    .slice(-MAX_OUTPUT_CHARS);
  return clean;
}

function capChatBuffer(value: string): string {
  return value.length > MAX_CHAT_BUFFER_CHARS ? value.slice(-MAX_CHAT_BUFFER_CHARS) : value;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function cleanTerminalLine(line: string): string {
  return line
    .replace(/\u001b/g, "")
    .replace(/\[[0-9]+;[0-9]+H/g, "")
    .replace(/\[[0-9]+[A-Z]/g, "")
    .replace(/[⠁-⣿⠀]/g, "")
    .replace(/[ \t]+$/g, "");
}

function filterMeaningfulChatLines(lines: string[]): string[] {
  const filtered: string[] = [];
  let skippingStartupPanel = false;
  let skippingRecallBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (startsRecallBlock(trimmed)) {
      skippingRecallBlock = true;
      continue;
    }
    if (skippingRecallBlock) {
      if (/^(Working \(|Ready\.|Welcome to Hermes Agent|[›❯]\s*)/i.test(trimmed)) skippingRecallBlock = false;
      else continue;
    }

    if (startsStartupPanel(trimmed)) {
      skippingStartupPanel = true;
      continue;
    }
    if (skippingStartupPanel) {
      if (/^(Welcome to Hermes Agent|✦?\s*Tip:|Working \(|Ready\.|[›❯]\s*)/i.test(trimmed)) {
        skippingStartupPanel = false;
      }
      continue;
    }

    if (isMeaningfulChatLine(line)) filtered.push(line);
  }
  return filtered;
}

function stripDecorativeBorders(line: string): string {
  return line
    .replace(/^[\s|│┃║]+/, "")
    .replace(/[\s|│┃║]+$/, "")
    .trimEnd();
}

function startsStartupPanel(line: string): boolean {
  return /^Available Tools\b/i.test(line)
    || /^MCP Servers\b/i.test(line)
    || /^Available Skills\b/i.test(line)
    || /^\[Context Workspace\]\s+\w+\s+ready\.?$/i.test(line)
    || /^\[Context Workspace\]\s+(Codex|OpenCode|Claude)\s+Hermes prompt:/i.test(line)
    || /^╭/.test(line);
}

function startsRecallBlock(line: string): boolean {
  return /^[›❯]?\s*You are running inside an embedded Context Workspace terminal\./i.test(line);
}

function isMeaningfulChatLine(line: string): boolean {
  const trimmed = normalizePromptPrefix(line.trim());
  if (!trimmed) return true;
  if (isTransientControlLine(trimmed)) return false;
  if (isThinkingLine(trimmed)) return false;
  if (isLowValueFragment(trimmed)) return false;
  if (isBoxDrawingLine(trimmed)) return false;
  if (isStartupChromeLine(trimmed)) return false;
  if (isRecallInjectionLine(trimmed)) return false;
  if (isRedrawNoiseLine(trimmed)) return false;
  return true;
}

function isBoxDrawingLine(line: string): boolean {
  const boxChars = line.match(/[╭╮╯╰│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬━┃┏┓┗┛┣┫┳┻╋]/g)?.length ?? 0;
  return boxChars > 0 && boxChars / Math.max(line.length, 1) > 0.18;
}

function isStartupChromeLine(line: string): boolean {
  return /^\[Context Workspace\]\s+\w+\s+ready\.?$/i.test(line)
    || /^\[Context Workspace\]\s+(Codex|OpenCode|Claude)\s+Hermes prompt:/i.test(line)
    || /^\[Context Workspace\]\s+OpenCode baseline binary selected/i.test(line)
    || /^Available Tools\b/i.test(line)
    || /^MCP Servers\b/i.test(line)
    || /^Available Skills\b/i.test(line)
    || /^\(?and \d+ more toolsets/i.test(line)
    || /^\d+\s+tools\s+·\s+\d+\s+skills/i.test(line)
    || /^Welcome to Hermes Agent/i.test(line)
    || /^✦?\s*Tip:/i.test(line)
    || /^[-•]?\s*Starting MCP servers/i.test(line)
    || /^Working \(/i.test(line)
    || /^Ready\.$/i.test(line)
    || /^[_>]\s+OpenAI Codex/i.test(line)
    || /^OpenCode\b/i.test(line)
    || /^model:\s+/i.test(line)
    || /^directory:\s+/i.test(line)
    || /^cwd:\s+/i.test(line)
    || /^provider:\s+/i.test(line)
    || /^session:\s+/i.test(line)
    || /^\/\w+\s+to\s+/i.test(line)
    || /^Tip:\s+/i.test(line)
    || /^gpt-[\w.-]+\s+/i.test(line)
    || /^MiniMax-[\w.-]+\s+·/i.test(line)
    || /^Session:\s+\d{8}_/i.test(line)
    || /^(browser|browser-cdp|clarify|code_execution|computer_use|cronjob|delegation|discord|email|gaming|general|github|hermes-agent|mcp|media|mlops|note-taking|productivity|projects|research|software-development|trading):\s+/i.test(line);
}

function isRecallInjectionLine(line: string): boolean {
  const trimmed = normalizePromptPrefix(line);
  return /^You are running inside an embedded Context Workspace terminal\./i.test(trimmed)
    || /^Agent:\s+/i.test(line)
    || /^Pane:\s+/i.test(line)
    || /^Workspace:\s+/i.test(line)
    || /^Context Workspace refreshed Hermes recall/i.test(line)
    || /^Recall cache path:/i.test(line)
    || /^Use the recall cache as short-lived project context/i.test(line)
    || /^Hermes session recall is attached below/i.test(line)
    || /^# Hermes recall for Context Workspace/i.test(line)
    || /^Generated by Context Workspace/i.test(line)
    || /^## (Current workspace|Operating contract|Native agent sessions)$/i.test(line)
    || /^- Project:\s+/i.test(line)
    || /^- Task hint:\s+/i.test(line)
    || /^- Backend:\s+/i.test(line)
    || /^- Hermes owns durable memory/i.test(line)
    || /^- Context Workspace owns app-side tools/i.test(line)
    || /^- Agents should consume this generated recall/i.test(line)
    || /^Native agent sessions for this workspace:/i.test(line)
    || /^-\s+\d{4}-\d{2}-\d{2}T.*\[(codex|opencode|claude|hermes),/i.test(line)
    || /^resume:\s+`?(codex|opencode|claude|hermes)\s+/i.test(line)
    || /^Hermes memory is attached below/i.test(line)
    || /^No Hermes memory entries are available\./i.test(line);
}

function isRedrawNoiseLine(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  return compact.length > 80 && /(StartingMCP|openaiDeveloperDocs|Working\(|esc to interrupt)/i.test(compact)
    || /(.)\1{8,}/.test(compact)
    || /(?:Sta|Start|Starti|Starting|MCP|server|servers).*(?:Sta|Start|Starti|Starting|MCP|server|servers).*(?:Sta|Start|Starti|Starting|MCP|server|servers)/i.test(line);
}

function isTransientControlLine(line: string): boolean {
  const trimmed = normalizePromptPrefix(line);
  return /^msg=interrupt\s+·?\s*\/queue\s+·?\s*\/bg\s+·?\s*\/steer\s+·?\s*Ctrl\+C cancel/i.test(trimmed)
    || /^msg=interrupt\s+\/queue\s+\/bg\s+\/steer/i.test(trimmed)
    || /^Initializing agent/i.test(trimmed)
    || /^(ctx|tokens?)\s/i.test(trimmed)
    || /^\d+(?:\.\d+)?[KMB]?\s*\(\d+%\)/i.test(trimmed)
    || /^Starting MCP servers/i.test(trimmed)
    || /^Working\s*\(/i.test(trimmed)
    || /^Explore\s*\(/i.test(trimmed)
    || /^Build\s*·/i.test(trimmed)
    || /^Parent up\s+Prev left\s+Next right/i.test(trimmed)
    || /^\d+s\s*·\s*esc to interrupt/i.test(trimmed)
    || /^esc to interrupt/i.test(trimmed);
}

function isThinkingLine(line: string): boolean {
  const trimmed = normalizePromptPrefix(line);
  return /^\S*[\s)]*(reflecting|reasoning|ruminating|thinking|working)\.{0,3}$/i.test(trimmed)
    || /^\(.*\)\s*(reflecting|reasoning|ruminating|thinking|working)\.{0,3}$/i.test(trimmed);
}

function isLowValueFragment(line: string): boolean {
  const trimmed = normalizePromptPrefix(line);
  return /^(?:[●•·\-*]\s*)?hi$/i.test(trimmed)
    || /^etc\.?\s+in\s+config\.ya?ml\.?$/i.test(line)
    || /^[0-9]+$/.test(trimmed)
    || /^[\s.·•*_-]{1,12}$/.test(trimmed);
}

function splitOutputIntoChunks(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/\n{3,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => splitLargeChunk(chunk, 2600));
}

function splitLargeChunk(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const splitAt = Math.max(remaining.lastIndexOf("\n", maxChars), Math.floor(maxChars * 0.72));
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isStatusLine(line: string): boolean {
  return /^\[process exited:/i.test(line)
    || /\b(error|failed|exception|traceback|permission denied|not found)\b/i.test(line);
}

function isPromptEchoLine(line: string): boolean {
  const trimmed = normalizePromptPrefix(line);
  return /^(?:[$#>]\s*)?$/.test(trimmed)
    || /^›\s*/.test(line.trim())
    || /^>\s*/.test(line.trim())
    || /^[\w.-]+@[\w.-]+:[^$#]*[$#]\s*$/.test(line)
    || /^Current status:\s*$/i.test(trimmed);
}

function normalizePromptPrefix(line: string): string {
  return line
    .replace(/^[\s⚕✦●•·*_\-│┃║]+/, "")
    .replace(/^[›❯>$#]\s*/, "")
    .trim();
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
