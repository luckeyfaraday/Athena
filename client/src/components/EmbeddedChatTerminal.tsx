import { DragEvent, FormEvent, KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Send, TerminalSquare } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  desktop,
  type EmbeddedTerminalDataPayload,
  type EmbeddedTerminalExitPayload,
  type EmbeddedTerminalSession,
} from "../electron";
import {
  CHAT_STREAM_ANCHOR_CHARS,
  chatDraftForSession,
  chatStreamEndForBuffer,
  confirmedChatPrompts,
  promptHistoryForSession,
  recordChatPromptForSession,
  saveChatDraft,
  subscribeChatPromptHistory,
  type SentPromptBlock,
  updateChatStreamAnchor,
  writePromptSequence,
} from "../chat-mode";
import { ChatTranscriptParser, SNAPSHOT_PARSE_CHARS, type ChatBlock } from "../chat-parse";
import { isNearScrollBottom } from "../embedded-scroll";
import { nativeChatBlocks } from "../native-chat";
import { useNativeChat } from "../use-native-chat";
import "./chat.css";

type Props = {
  session: EmbeddedTerminalSession;
  onOpenTerminal?: () => void;
};

/** Minimum spacing between parses/renders while output keeps streaming (TUIs redraw constantly). */
const CHAT_OUTPUT_FLUSH_MS = 200;
/** Delay for the first flush after a quiet period, so sporadic output (echo, short replies) stays snappy. */
const CHAT_OUTPUT_IDLE_FLUSH_MS = 32;
/** Output beyond this per flush is dropped from the front (the parser records the gap). */
const MAX_PENDING_OUTPUT_CHARS = SNAPSHOT_PARSE_CHARS;
const EXIT_STREAM_RECOVERY_MS = 2_500;
const EMPTY_BLOCKS: ChatBlock[] = [];

function EmbeddedChatTerminalView({ session, onOpenTerminal }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const dragDepthRef = useRef(0);
  const parserRef = useRef<ChatTranscriptParser | null>(null);
  const [prompt, setPromptState] = useState(() => chatDraftForSession(session.id));
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentRef = useRef<HTMLInputElement | null>(null);
  const sendingRef = useRef(false);
  const flushRef = useRef<(() => void) | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const { snapshot, snapshotRef, historyError } = useNativeChat(session);
  function setPrompt(value: string) {
    saveChatDraft(session.id, value);
    setPromptState(value);
  }
  const [sentPrompts, setSentPrompts] = useState<SentPromptBlock[]>(() => promptHistoryForSession(session));
  const sentPromptsRef = useRef(sentPrompts);
  const titleRef = useRef(session.title);
  const [chatBlocks, setChatBlocks] = useState<ChatBlock[]>(EMPTY_BLOCKS);
  const chatBlocksRef = useRef(chatBlocks);
  const [imageDropActive, setImageDropActive] = useState(false);
  const visibleBlocks = snapshot
    ? nativeChatBlocks(snapshot.messages, sentPrompts, session.title, confirmedChatPrompts(session.id))
    : chatBlocks;
  const visibleSignature = visibleBlocks.map((block) => `${block.id}:${block.text.length}`).join("|");

  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(160, Math.max(42, input.scrollHeight))}px`;
  }, [prompt]);

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
    let attachRetryTimer = 0;
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
    flushRef.current = flushPendingData;
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
      let snapshot;
      try {
        snapshot = await desktop.attachEmbeddedTerminalStream(session.id);
      } catch (error) {
        if (!mounted || generation !== attachGeneration) return;
        setStreamError(error instanceof Error ? error.message : "Could not connect to the conversation.");
        beforeAttach.length = 0;
        attachRetryTimer = window.setTimeout(() => void attachStream(), 2_000);
        return;
      }
      if (!mounted || generation !== attachGeneration) return;
      setStreamError(null);
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
      window.clearTimeout(attachRetryTimer);
      flushRef.current = null;
      clearFlushTimer();
      pendingData = "";
      beforeAttach.length = 0;
      removeData();
      removeExit();
      if (parserRef.current === parser) parserRef.current = null;
    };
  }, [publish, session.id, retry]);

  // Follow new output only when the blocks changed and the reader is already at
  // the bottom (tracked on scroll), so reading older bubbles is never yanked.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleSignature]);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || session.status !== "running" || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    // Pending terminal output belongs to the preceding turn, not this prompt.
    flushRef.current?.();
    const marker = parserRef.current?.position ?? 0;
    const nativeAfter = snapshotRef.current?.messages.at(-1)?.id;
    stickToBottomRef.current = true;
    try {
      await writePromptToSession(session, trimmed);
      setSentPrompts(recordChatPromptForSession(session.id, trimmed, marker, nativeAfter));
      setPrompt("");
    } catch (error) {
      setSendError(`Message could not be sent: ${error instanceof Error ? error.message : String(error)}. Your draft is saved. Open the terminal to check whether any text reached the agent before retrying.`);
    } finally {
      sendingRef.current = false;
      setSending(false);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
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
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
    await attachImages(images);
  }

  async function attachImages(images: File[]) {
    const paths = await desktop.getDroppedFilePaths(images).catch(() => []);
    const pasted = paths.filter(Boolean).map(quoteTerminalPath).join(" ");
    if (!pasted) { setSendError("Could not attach the image. Try dragging it from your file manager."); return; }
    const current = chatDraftForSession(session.id);
    setPrompt(`${current}${current && !current.endsWith(" ") ? " " : ""}${pasted} `);
    composerRef.current?.focus();
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
        <strong>{session.status === "running" ? (sending ? "Sending…" : "Connected") : session.status === "failed" ? "Failed" : "Exited"}</strong>
        <em>{session.title}</em>
        {session.status === "running" && <button type="button" disabled={sending} title="Send Escape to interrupt or dismiss a prompt" onClick={() => {
          void desktop.writeEmbeddedTerminal(session.id, "\x1b").catch((error) => setSendError(String(error)));
        }}>Esc</button>}
        {onOpenTerminal && <button type="button" onClick={onOpenTerminal} title="Open terminal for approvals, menus, and live activity"><TerminalSquare size={14} /> Terminal</button>}
      </div>
      <div className="embeddedChatTranscript" ref={scrollRef} onScroll={handleTranscriptScroll} aria-label="Conversation">
        {visibleBlocks.length ? (
          visibleBlocks.map((block) => <ChatBubble key={block.id} block={block} />)
        ) : (
          <div className="chatEmptyState">
            <strong>{session.status === "running" ? `Message ${session.title}` : "No conversation captured"}</strong>
            <span>{session.status === "running" ? "Send a message to get started. Open Terminal if the agent needs an approval or a menu selection." : "Open Terminal to inspect the session output."}</span>
          </div>
        )}
      </div>
      <form className="embeddedChatComposer" onSubmit={submitPrompt}>
        {(sendError || streamError || historyError || session.error) && <div className="chatError" role="alert">
          <span>{sendError || streamError || historyError || session.error}</span>
          {streamError && <button type="button" onClick={() => setRetry((value) => value + 1)}>Reconnect</button>}
        </div>}
        <input ref={attachmentRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
          void attachImages(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
        <button type="button" title="Attach image" aria-label="Attach image" disabled={session.status !== "running" || sending} onClick={() => attachmentRef.current?.click()}><ImagePlus size={16} /></button>
        <textarea
          ref={composerRef}
          aria-label={`Message ${session.title}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={session.status === "running" ? `Message ${session.title}` : "Session is not running"}
          disabled={session.status !== "running" || sending}
          rows={1}
        />
        <button type="submit" disabled={session.status !== "running" || sending || prompt.trim().length === 0} title="Send message" aria-label="Send message">
          <Send size={14} />
        </button>
        <small className="chatComposerHint">Enter to send · Shift+Enter for a new line</small>
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
      {block.role === "assistant"
        ? <div className="chatMarkdown"><Markdown remarkPlugins={[remarkGfm]} components={{
            a: ({ children, href }) => <a href={href} onClick={(event) => {
              event.preventDefault();
              if (href) void desktop.openExternalUrl(href).catch(() => undefined);
            }}>{children}</a>,
          }}>{block.text}</Markdown></div>
        : <pre>{block.text}</pre>}
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
    && a.providerSessionId === b.providerSessionId
    && a.error === b.error
  );
});

async function writePromptToSession(session: EmbeddedTerminalSession, prompt: string): Promise<void> {
  await writePromptSequence(
    session.kind,
    prompt,
    (data) => desktop.writeEmbeddedTerminal(session.id, data),
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
  return `"${path.replace(/"/g, '\\"')}"`;
}
