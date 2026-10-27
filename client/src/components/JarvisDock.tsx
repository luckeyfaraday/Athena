import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AudioLines, Bot, ChevronDown, ChevronUp, CornerDownLeft, Keyboard, Megaphone, Mic, MicOff } from "lucide-react";
import { desktop, type JarvisFeedItem, type JarvisState } from "../electron";
import {
  jarvisActivityView,
  jarvisDockMeta,
  jarvisDockPreview,
  jarvisErrorMessage,
  jarvisFeedLabel,
  jarvisFeedRole,
  jarvisRelativeTime,
} from "../jarvis-view";
import "./jarvis-dock.css";

// Jarvis in the Command Room, for Jarvis license holders only. A strip under the
// terminals of whichever machine is shown: Jarvis runs on this computer but works
// with every machine on the tailnet. Collapsed it is one line (status, what it is
// hearing, the ask box); open, the recent feed sits above that line.

// Relative times in the open feed are refreshed this often.
const FEED_TICK_MS = 30_000;
// How long "Opening…" may stand in for "Not running" after a launch.
const OPENING_GRACE_MS = 20_000;
// A reader scrolled further than this from the bottom is not pulled back down.
const FEED_PIN_SLACK_PX = 24;

const feedIcons: Record<JarvisFeedItem["kind"], ReactNode> = {
  heard: <Mic size={11} />,
  asked: <Keyboard size={11} />,
  said: <AudioLines size={11} />,
  announce: <Megaphone size={11} />,
  agent: <Bot size={11} />,
};

export function JarvisDock({
  state,
  collapsed,
  focusRequest,
  onCollapsedChange,
  onFocusHandled,
  onState,
}: {
  state: JarvisState;
  collapsed: boolean;
  // When the nonce changes, focus the ask box (the palette's "Ask Jarvis…"), then
  // report it handled so a remount does not replay it.
  focusRequest: number | null;
  onCollapsedChange: (collapsed: boolean) => void;
  onFocusHandled: () => void;
  onState: (state: JarvisState) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"ask" | "mic" | "launch" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const feedRef = useRef<HTMLOListElement | null>(null);
  const pinnedRef = useRef(true);
  const feedId = useId();
  const activity = jarvisActivityView(state);
  const lastFeedId = state.feed.at(-1)?.id ?? null;

  useEffect(() => {
    if (focusRequest == null) return;
    inputRef.current?.focus();
    onFocusHandled();
  }, [focusRequest]);

  useEffect(() => {
    if (collapsed) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), FEED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [collapsed]);

  // New lines scroll into view unless the reader has scrolled up.
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && !collapsed && pinnedRef.current) feed.scrollTop = feed.scrollHeight;
  }, [lastFeedId, state.partial, collapsed]);

  // Covers the seconds between launching Jarvis and its session appearing.
  useEffect(() => {
    if (!opening) return undefined;
    if (state.running) {
      setOpening(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setOpening(false), OPENING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [opening, state.running]);

  async function run(kind: "ask" | "mic" | "launch", action: () => Promise<JarvisState>): Promise<boolean> {
    setPending(kind);
    setError(null);
    try {
      onState(await action());
      return true;
    } catch (caught) {
      setError(jarvisErrorMessage(caught));
      return false;
    } finally {
      setPending(null);
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending === "ask") return;
    if (!(await run("ask", () => desktop.askJarvis(text)))) return;
    pinnedRef.current = true;
    // Keep anything typed while the request was in flight.
    setDraft((current) => (current.trim() === text ? "" : current));
  }

  async function launch() {
    if (await run("launch", () => desktop.launchJarvis())) setOpening(true);
  }

  const micOpen = state.micOpen === true;
  const preview = collapsed ? jarvisDockPreview(state) : null;
  const meta = collapsed ? null : jarvisDockMeta(state);
  const statusLabel = !state.running && (opening || pending === "launch") ? "Opening…" : activity.label;

  return (
    <section className={collapsed ? "jarvisDock collapsed" : "jarvisDock"} aria-label="Jarvis">
      <ol
        className="jarvisFeed"
        id={feedId}
        ref={feedRef}
        role="log"
        aria-label="Jarvis conversation"
        hidden={collapsed}
        onScroll={(event) => {
          const feed = event.currentTarget;
          pinnedRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < FEED_PIN_SLACK_PX;
        }}
      >
        {state.feed.map((item) => <JarvisFeedLine key={item.id} item={item} />)}
        {state.partial && (
          <li className="jarvisFeedItem user live">
            <span className="jarvisFeedLabel">{feedIcons.heard} You</span>
            <p>{state.partial}</p>
          </li>
        )}
        {state.feed.length === 0 && !state.partial && (
          <li className="jarvisFeedEmpty">
            {state.running
              ? "Talk to Jarvis or type below. What you say, its replies, and your agents' alerts show up here."
              : "Open Jarvis to talk to it from Athena. Its replies and your agents' alerts will show up here."}
          </li>
        )}
      </ol>
      <div className="jarvisBar">
        <span className={`jarvisOrb ${activity.tone}`} aria-hidden="true" />
        <div className="jarvisIdentity">
          <strong>Jarvis</strong>
          <span>{statusLabel}</span>
        </div>
        <div className="jarvisPreview">
          {preview ? (
            <span className={preview.live ? "live" : undefined} title={preview.text}>
              {preview.live && <Mic size={12} aria-hidden="true" />}
              {preview.text}
            </span>
          ) : meta ? (
            <span className="jarvisMeta" title={meta}>{meta}</span>
          ) : null}
        </div>
        <form className="searchField jarvisAsk" onSubmit={(event) => void ask(event)}>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            placeholder="Ask Jarvis…"
            aria-label="Ask Jarvis"
            spellCheck={false}
            autoComplete="off"
            maxLength={4000}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && draft) {
                event.stopPropagation();
                setDraft("");
              }
            }}
          />
          <button
            type="submit"
            className="iconButton"
            disabled={!draft.trim() || pending === "ask"}
            aria-label="Send to Jarvis"
            title="Send (Enter)"
          >
            <CornerDownLeft size={13} />
          </button>
        </form>
        {state.connected && (
          <button
            type="button"
            className={micOpen ? "iconButton outlined jarvisMic on" : "iconButton outlined jarvisMic"}
            aria-pressed={micOpen}
            aria-label="Jarvis microphone"
            title={micOpen ? "Mute Jarvis's microphone" : "Turn Jarvis's microphone on"}
            disabled={pending === "mic"}
            onClick={() => void run("mic", () => desktop.setJarvisMic("toggle"))}
          >
            {micOpen ? <Mic size={14} /> : <MicOff size={14} />}
          </button>
        )}
        {!state.running && (
          <button
            type="button"
            className="ghostButton small"
            disabled={opening || pending === "launch"}
            title="Start the Jarvis app on this computer"
            onClick={() => void launch()}
          >
            <AudioLines size={13} /> Open Jarvis
          </button>
        )}
        <button
          type="button"
          className="iconButton"
          aria-expanded={!collapsed}
          aria-controls={feedId}
          aria-label={collapsed ? "Show the Jarvis feed" : "Hide the Jarvis feed"}
          title={collapsed ? "Show the feed" : "Hide the feed"}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {error && <p className="jarvisDockError" role="alert">{error}</p>}
    </section>
  );
}

function JarvisFeedLine({ item }: { item: JarvisFeedItem }) {
  const at = new Date(item.at);
  return (
    <li className={`jarvisFeedItem ${jarvisFeedRole(item)} ${item.kind}`}>
      <span className="jarvisFeedLabel">
        {feedIcons[item.kind]} {jarvisFeedLabel(item)}
        <time dateTime={at.toISOString()} title={at.toLocaleString()}>{jarvisRelativeTime(item.at)}</time>
      </span>
      <p>{item.text}</p>
    </li>
  );
}
