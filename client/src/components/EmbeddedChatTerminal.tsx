import { DragEvent, FormEvent, KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Send, TerminalSquare } from "lucide-react";
import {
  desktop,
  type EmbeddedTerminalDataPayload,
  type EmbeddedTerminalExitPayload,
  type EmbeddedTerminalSession,
} from "../electron";
import {
  CHAT_STREAM_ANCHOR_CHARS,
  chatStreamEndForBuffer,
  promptHistoryForSession,
  recordChatPromptForSession,
  subscribeChatPromptHistory,
  type SentPromptBlock,
  updateChatStreamAnchor,
  writePromptSequence,
} from "../chat-mode";
import { ChatTranscriptParser, SNAPSHOT_PARSE_CHARS, type ChatBlock } from "../chat-parse";
import { isNearScrollBottom } from "../embedded-scroll";

type Props = {
  session: EmbeddedTerminalSession;
};

/** Minimum spacing between parses/renders while output keeps streaming (TUIs redraw constantly). */
const CHAT_OUTPUT_FLUSH_MS = 200;
/** Delay for the first flush after a quiet period, so sporadic output (echo, short replies) stays snappy. */
const CHAT_OUTPUT_IDLE_FLUSH_MS = 32;
/** Output beyond this per flush is dropped from the front (the parser records the gap). */
const MAX_PENDING_OUTPUT_CHARS = SNAPSHOT_PARSE_CHARS;
const EXIT_STREAM_RECOVERY_MS = 2_500;
const EMPTY_BLOCKS: ChatBlock[] = [];

function EmbeddedChatTerminalView({ session }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const dragDepthRef = useRef(0);
  const parserRef = useRef<ChatTranscriptParser | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sentPrompts, setSentPrompts] = useState<SentPromptBlock[]>(() => promptHistoryForSession(session));
  const sentPromptsRef = useRef(sentPrompts);
  const titleRef = useRef(session.title);
  const [chatBlocks, setChatBlocks] = useState<ChatBlock[]>(EMPTY_BLOCKS);
  const chatBlocksRef = useRef(chatBlocks);
  const [imageDropActive, setImageDropActive] = useState(false);

  // Rebuild the visible blocks from the parser; re-render only when they changed
  // (the parser returns the same array instance when nothing visible changed).
  const publish = useCallback((parser: ChatTranscriptParser | null) => {
    if (!parser || parser !== parserRef.current) return;
    const next = parser.view(sentPromptsRef.current, titleRef.current);
    if (next === chatBlocksRef.current) return;
    chatBlocksRef.current = next;
    setChatBlocks(next);
  }, []);

  useLayoutEffect(() => {
    sentPromptsRef.current = sentPrompts;
    titleRef.current = session.title;
    publish(parserRef.current);
  }, [publish, sentPrompts, session.title]);

  useEffect(() => {
    const parser = new ChatTranscriptParser();
    parserRef.current = parser;
    if (chatBlocksRef.current !== EMPTY_BLOCKS) {
      chatBlocksRef.current = EMPTY_BLOCKS;
      setChatBlocks(EMPTY_BLOCKS);
    }
    let mounted = true;
    let attached = false;
    let streamEpoch: string | null = null;
    let throughSequence = 0;
    let attachGeneration = 0;
    let pendingExit: EmbeddedTerminalExitPayload | null = null;
    let exitRendered = false;
    let exitReattachAttempted = false;
    let exitRecoveryTimer = 0;
    const beforeAttach: EmbeddedTerminalDataPayload[] = [];
    let pendingData = "";
    let droppedChars = 0;
    let flushTimer = 0;
    let lastFlushAt = -Infinity;
    const clearFlushTimer = () => {
      if (flushTimer) window.clearTimeout(flushTimer);
      flushTimer = 0;
    };
    const resetStream = (text: string) => {
      clearFlushTimer();
      pendingData = "";
      droppedChars = 0;
      // Map the snapshot into the session's stream coordinates so prompt
      // markers recorded before a remount still land in the right place.
      const end = chatStreamEndForBuffer(session.id, text);
      parser.reset(text, sentPromptsRef.current.map((block) => block.marker), end - text.length);
      publish(parser);
    };
    const appendNow = (text: string) => {
      parser.append(text);
      updateChatStreamAnchor(session.id, parser.position, parser.recentRaw(CHAT_STREAM_ANCHOR_CHARS));
      publish(parser);
    };
    const flushPendingData = () => {
      clearFlushTimer();
      if (!mounted || (!pendingData && !droppedChars)) return;
      const data = pendingData;
      const dropped = droppedChars;
      pendingData = "";
      droppedChars = 0;
      lastFlushAt = performance.now();
      parser.skip(dropped);
      appendNow(data);
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      const wait = Math.max(CHAT_OUTPUT_IDLE_FLUSH_MS, lastFlushAt + CHAT_OUTPUT_FLUSH_MS - performance.now());
      flushTimer = window.setTimeout(flushPendingData, wait);
    };
    const enqueueOutput = (data: string) => {
      pendingData += data;
      if (pendingData.length > MAX_PENDING_OUTPUT_CHARS) {
        const excess = pendingData.length - MAX_PENDING_OUTPUT_CHARS;
        droppedChars += excess;
        pendingData = pendingData.slice(excess);
      }
      scheduleFlush();
    };
    const renderPendingExit = () => {
      if (!pendingExit || exitRendered || !attached) return;
      if (pendingExit.epoch && streamEpoch && pendingExit.epoch !== streamEpoch) {
        if (!exitReattachAttempted) {
          exitReattachAttempted = true;
          void attachStream();
          return;
        }
        const exit = pendingExit;
        pendingExit = null;
        exitRendered = true;
        if (exitRecoveryTimer) window.clearTimeout(exitRecoveryTimer);
        exitRecoveryTimer = 0;
        flushPendingData();
        appendNow(
          "\n[Athena: final terminal history expired before this view attached]"
          + `\n[process exited: ${exit.exitCode ?? "unknown"}]\n`,
        );
        return;
      }
      if ((pendingExit.throughSequence ?? throughSequence) > throughSequence) {
        if (!exitRecoveryTimer) {
          exitRecoveryTimer = window.setTimeout(() => {
            exitRecoveryTimer = 0;
            if (pendingExit && !exitRendered) void attachStream();
          }, EXIT_STREAM_RECOVERY_MS);
        }
        return;
      }
      const exit = pendingExit;
      pendingExit = null;
      exitRendered = true;
      if (exitRecoveryTimer) window.clearTimeout(exitRecoveryTimer);
      exitRecoveryTimer = 0;
      flushPendingData();
      appendNow(`\n[process exited: ${exit.exitCode ?? "unknown"}]\n`);
    };
    const applyPayload = (payload: EmbeddedTerminalDataPayload) => {
      if (!attached) {
        beforeAttach.push(payload);
        return;
      }
      if (payload.epoch !== streamEpoch || (!payload.reset && payload.fromSequence > throughSequence + 1)) {
        void attachStream();
        return;
      }
      if (payload.sequence <= throughSequence) return;
      throughSequence = payload.sequence;
      if (payload.reset) resetStream(payload.data);
      else enqueueOutput(payload.data);
      renderPendingExit();
    };
    const attachStream = async () => {
      const generation = ++attachGeneration;
      attached = false;
      const snapshot = await desktop.attachEmbeddedTerminalStream(session.id).catch(() => null);
      if (!snapshot || !mounted || generation !== attachGeneration) return;
      streamEpoch = snapshot.epoch;
      throughSequence = snapshot.throughSequence;
      resetStream(snapshot.buffer);
      attached = true;
      const deferred = beforeAttach.splice(0);
      for (const payload of deferred) {
        if (payload.epoch === snapshot.epoch && payload.sequence <= snapshot.throughSequence) continue;
        applyPayload(payload);
      }
      renderPendingExit();
    };

    const removeData = desktop.onEmbeddedTerminalDataFor(session.id, applyPayload);
    void attachStream();
    const removeExit = desktop.onEmbeddedTerminalExit((payload) => {
      if (payload.id === session.id) {
        pendingExit = payload;
        exitReattachAttempted = false;
        renderPendingExit();
      }
    });

    return () => {
      mounted = false;
      attachGeneration += 1;
      if (exitRecoveryTimer) window.clearTimeout(exitRecoveryTimer);
      clearFlushTimer();
      pendingData = "";
      beforeAttach.length = 0;
      removeData();
      removeExit();
      if (parserRef.current === parser) parserRef.current = null;
    };
  }, [publish, session.id]);

  // Follow new output only when the blocks changed and the reader is already at
  // the bottom (tracked on scroll), so reading older bubbles is never yanked.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatBlocks]);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || session.status !== "running") return;
    const marker = parserRef.current?.position ?? 0;
    setPrompt("");
    stickToBottomRef.current = true;
    setSentPrompts(recordChatPromptForSession(session.id, trimmed, marker));
    await writePromptToSession(session, trimmed);
  }

  useEffect(() => {
    setSentPrompts(promptHistoryForSession(session));
    return subscribeChatPromptHistory(session.id, () => setSentPrompts(promptHistoryForSession(session)));
  }, [session.id]);

  function handleTranscriptScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearScrollBottom(el);
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
      <div className="embeddedChatTranscript" ref={scrollRef} onScroll={handleTranscriptScroll}>
        {chatBlocks.length ? (
          chatBlocks.map((block) => <ChatBubble key={block.id} block={block} />)
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

const ChatBubble = memo(function ChatBubble({ block }: { block: ChatBlock }) {
  return (
    <article className={`chatBubble ${block.role}`}>
      <span>
        {block.role === "status" ? <AlertTriangle size={13} /> : block.role === "assistant" ? <TerminalSquare size={13} /> : null}
        {block.label}
      </span>
      <pre>{block.text}</pre>
    </article>
  );
}, (prev, next) => prev.block === next.block || (
  prev.block.role === next.block.role
  && prev.block.label === next.block.label
  && prev.block.text === next.block.text
));

/**
 * Parent panes re-render (and hand us fresh session objects) on every session
 * poll; only re-render for the session fields this view actually reads.
 */
export const EmbeddedChatTerminal = memo(EmbeddedChatTerminalView, (prev, next) => {
  const a = prev.session;
  const b = next.session;
  return a === b || (
    a.id === b.id
    && a.kind === b.kind
    && a.status === b.status
    && a.pid === b.pid
    && a.title === b.title
    && a.initialTask === b.initialTask
  );
});

async function writePromptToSession(session: EmbeddedTerminalSession, prompt: string): Promise<void> {
  await writePromptSequence(
    session.kind,
    prompt,
    (data) => desktop.writeEmbeddedTerminal(session.id, data).catch(() => undefined),
    delay,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
