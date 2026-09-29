// Decides when a terminal genuinely needs the user, from how it behaves rather than from loose words in its output.
// Three signals, strongest first:
//  1. Notifications the program asks the terminal to show: OSC 9 / 777 / 99 and a bare BEL.
//  2. An agent prompt on screen (approval, question, folder trust, y/n), confirmed only once the terminal holds still,
//     so a diff or file that merely contains the words while the agent keeps working does not count.
//  3. An agent turn finishing: input arms it, sustained output marks the turn busy, and the output going quiet ends it.
// On Windows the stream comes through ConPTY, which redraws only changed cells and writes skipped cells as cursor
// moves (a space often arrives as ESC[1C), so the scanner rebuilds visible text from cursor movement.

export type TerminalAttentionKind = "action" | "update";

export type TerminalAttentionReason =
  | "approval"
  | "question"
  | "trust"
  | "yes-no"
  | "turn-complete"
  | "notification"
  | "bell"
  | "exit";

export type TerminalAttentionEvent = {
  id: string;
  kind: TerminalAttentionKind;
  reason: TerminalAttentionReason;
  message: string | null;
};

export type TerminalAttentionTimings = {
  // At most one prompt scan per terminal per interval (leading + trailing).
  scanThrottleMs: number;
  // A prompt counts once the terminal stays nearly still this long after drawing it...
  promptConfirmMs: number;
  // ...drawing at most this many visible updates meanwhile (Claude Code blinks a dot at its prompts; a working
  // agent's spinner redraws about ten times a second).
  promptConfirmMaxUpdates: number;
  // A busy agent turn is over once visible output stops for this long.
  turnSettleMs: number;
  // Shorter bursts (redraws, menus opening) are not turns.
  turnMinBusyMs: number;
  // Output this soon after input is the echo of that input, not the agent working.
  inputEchoGraceMs: number;
  // A bell this soon after input is keystroke feedback (a failed tab completion), not a notification.
  bellInputGraceMs: number;
};

export const TERMINAL_ATTENTION_TIMINGS: TerminalAttentionTimings = {
  scanThrottleMs: 200,
  promptConfirmMs: 1_500,
  promptConfirmMaxUpdates: 4,
  turnSettleMs: 3_000,
  turnMinBusyMs: 2_000,
  inputEchoGraceMs: 400,
  bellInputGraceMs: 1_000,
};

export const TERMINAL_ATTENTION_SCAN_MAX_CHARS = 4_000;
const TERMINAL_ATTENTION_CARRY_CHARS = 120;
const OSC_MAX_CHARS = 2_048;
const CSI_MAX_PARAM_CHARS = 32;
const MAX_CURSOR_FORWARD = 256;
const NOTIFICATION_MAX_CHARS = 160;

type PromptMatch = { reason: TerminalAttentionReason; message: string };

const APPROVAL_MESSAGE = "Waiting for your approval";
const QUESTION_MESSAGE = "Asking you a question";
const TRUST_MESSAGE = "Asking to trust this folder";
const YES_NO_MESSAGE = "Waiting for a yes/no answer";

// Prompt text as the agent CLIs print it (checked against Claude Code 2.1, Codex 0.159, OpenCode, Grok and Hermes).
// Patterns are written against whitespace-collapsed text.
const AGENT_PROMPT_PATTERNS: Array<{ pattern: RegExp; reason: TerminalAttentionReason; message: string }> = [
  // Claude Code tool permissions and plan approval; Codex and Grok share the "tell X what to do differently" option.
  { pattern: /\bdo you want to (?:proceed|make this edit|create|allow|use this|overwrite|delete|apply|run)\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  { pattern: /\btell (?:claude|codex|grok|opencode|hermes|athena|the agent) what to do differently\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  { pattern: /\byes, and don['’]t ask again\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  { pattern: /\bno, keep planning\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  // Codex approvals.
  { pattern: /\bwould you like to (?:proceed|run the following command|make the following edits|grant these permissions|send input to)\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  // OpenCode / Athena Code, Grok and Hermes approvals.
  { pattern: /\bpermission required\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  { pattern: /\ballow once\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  { pattern: /\bdangerous command\b/i, reason: "approval", message: APPROVAL_MESSAGE },
  // Claude Code questions (AskUserQuestion).
  { pattern: /\benter to select\b/i, reason: "question", message: QUESTION_MESSAGE },
  { pattern: /\bchat about this\b/i, reason: "question", message: QUESTION_MESSAGE },
  // Folder trust before an agent starts (Claude Code, Codex).
  { pattern: /\byes, i trust this folder\b/i, reason: "trust", message: TRUST_MESSAGE },
  { pattern: /\btrust this folder\?/i, reason: "trust", message: TRUST_MESSAGE },
];

// A shell or agent asking y/n: only when the question is the last thing printed.
const YES_NO_PROMPT_PATTERN = /(?:\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\))\s*[:?]?\s*$/i;

const NOTIFICATION_ACTION_PATTERN = /\b(?:permission|approv\w*|needs? your|waiting for (?:your )?(?:input|approval|you)|input needed|confirm\w*|allow)\b/i;

const AGENT_PROMPT_SCANNERS = AGENT_PROMPT_PATTERNS.map((prompt) => ({ ...prompt, global: new RegExp(prompt.pattern.source, "gi") }));

/** Finds an attention prompt in whitespace-collapsed text, ignoring matches that end at or before `from` (already scanned). */
export function matchAttentionPrompt(text: string, from = 0): PromptMatch | null {
  for (const { global, reason, message } of AGENT_PROMPT_SCANNERS) {
    for (const match of text.matchAll(global)) {
      if ((match.index ?? 0) + match[0].length > from) return { reason, message };
    }
  }
  const yesNo = YES_NO_PROMPT_PATTERN.exec(text);
  if (yesNo && yesNo.index + yesNo[0].trimEnd().length > from) return { reason: "yes-no", message: YES_NO_MESSAGE };
  return null;
}

export function classifyNotificationText(text: string): TerminalAttentionKind {
  return NOTIFICATION_ACTION_PATTERN.test(text) ? "action" : "update";
}

// Bytes a terminal emulator sends on its own (focus changes, replies to queries, mouse motion and wheel) rather than
// the user typing. They must not count as the user answering a prompt or starting a turn.
const TERMINAL_REPORT_PATTERN = new RegExp([
  "\\x1b\\[[IO]", // focus in / out
  "\\x1b\\[\\d+;\\d+R", // cursor position report
  "\\x1b\\[[?>=][\\d;]*c", // device attributes
  "\\x1b\\[\\d*n", // device status
  "\\x1b\\[\\??[\\d;]*\\$y", // mode report
  "\\x1b\\[\\?\\d*u", // keyboard protocol flags
  "\\x1b\\[\\d+(?:;\\d+)*t", // window size reports
  "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC replies (colors, clipboard)
  "\\x1bP[^\\x1b]*\\x1b\\\\", // DCS replies (version, settings)
  "\\x1b\\[<(?:(?:3[2-9]|[4-9]\\d|\\d{3,});\\d+;\\d+[Mm]|\\d+;\\d+;\\d+m)", // mouse motion, wheel, button release
].join("|"), "g");

export function isTerminalReportInput(data: string): boolean {
  return data.length > 0 && data.replace(TERMINAL_REPORT_PATTERN, "").length === 0;
}

type ParseMode = "ground" | "esc" | "escIntermediate" | "csi" | "osc" | "oscEsc" | "string" | "stringEsc";

export type TerminalScanState = {
  mode: ParseMode;
  params: string;
  osc: string;
  oscOverflow: boolean;
};

export type TerminalScanResult = {
  // Visible text, with cursor movement turned into spaces and line breaks.
  text: string;
  // Whether any non-blank character was drawn.
  printable: boolean;
  // BEL characters outside OSC / DCS strings.
  bells: number;
  // Bodies of desktop notifications requested through OSC 9, 777 or 99.
  notifications: string[];
};

export function createTerminalScanState(): TerminalScanState {
  return { mode: "ground", params: "", osc: "", oscOverflow: false };
}

/** Parses one chunk of terminal output, carrying escape-sequence state across chunk boundaries in `state`. */
export function scanTerminalOutput(
  state: TerminalScanState,
  data: string,
  maxTextChars = TERMINAL_ATTENTION_SCAN_MAX_CHARS,
): TerminalScanResult {
  const parts: string[] = [];
  const notifications: string[] = [];
  let printable = false;
  let bells = 0;
  let runStart = -1;
  let oscStart = state.mode === "osc" ? 0 : -1;

  const flushRun = (end: number) => {
    if (runStart >= 0) parts.push(data.slice(runStart, end));
    runStart = -1;
  };
  const appendOsc = (end: number) => {
    if (oscStart < 0 || state.oscOverflow) return;
    const next = state.osc + data.slice(oscStart, end);
    if (next.length > OSC_MAX_CHARS) {
      state.osc = "";
      state.oscOverflow = true;
    } else {
      state.osc = next;
    }
  };
  const finishOsc = () => {
    const body = state.oscOverflow ? null : notificationFromOsc(state.osc);
    if (body) notifications.push(body);
    state.osc = "";
    state.oscOverflow = false;
    oscStart = -1;
  };

  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    switch (state.mode) {
      case "ground":
        if (code === 0x1b) {
          flushRun(index);
          state.mode = "esc";
        } else if (code < 0x20 || code === 0x7f) {
          flushRun(index);
          if (code === 0x07) bells += 1;
          else if (code === 0x0a || code === 0x0d) parts.push("\n");
          else if (code === 0x09) parts.push(" ");
        } else {
          if (runStart < 0) runStart = index;
          if (code !== 0x20 && code !== 0xa0) printable = true;
        }
        break;
      case "esc":
        if (code === 0x5b) {
          state.mode = "csi";
          state.params = "";
        } else if (code === 0x5d) {
          state.mode = "osc";
          state.osc = "";
          state.oscOverflow = false;
          oscStart = index + 1;
        } else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
          state.mode = "string";
        } else if (code >= 0x20 && code <= 0x2f) {
          state.mode = "escIntermediate";
        } else if (code !== 0x1b) {
          state.mode = "ground";
        }
        break;
      case "escIntermediate":
        if (code < 0x20 || code > 0x2f) state.mode = code === 0x1b ? "esc" : "ground";
        break;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) {
          const movement = cursorMovementText(code, state.params);
          if (movement) parts.push(movement);
          state.mode = "ground";
        } else if (code === 0x1b) {
          state.mode = "esc";
        } else if (code >= 0x20 && state.params.length < CSI_MAX_PARAM_CHARS) {
          state.params += data[index];
        }
        break;
      case "osc":
        if (code === 0x07) {
          appendOsc(index);
          finishOsc();
          state.mode = "ground";
        } else if (code === 0x1b) {
          appendOsc(index);
          oscStart = -1;
          state.mode = "oscEsc";
        }
        break;
      case "oscEsc":
        if (code === 0x5c) {
          finishOsc();
          state.mode = "ground";
        } else {
          // ESC without "\" aborts the string; reprocess this byte as the start of a new sequence.
          state.osc = "";
          state.oscOverflow = false;
          state.mode = "esc";
          index -= 1;
        }
        break;
      case "string":
        if (code === 0x1b) state.mode = "stringEsc";
        else if (code === 0x07) state.mode = "ground";
        break;
      case "stringEsc":
        if (code === 0x5c) {
          state.mode = "ground";
        } else {
          state.mode = "esc";
          index -= 1;
        }
        break;
    }
  }
  flushRun(data.length);
  if (state.mode === "osc") appendOsc(data.length);

  let text = parts.join("");
  if (text.length > maxTextChars) text = text.slice(-maxTextChars);
  return { text, printable, bells, notifications };
}

function cursorMovementText(finalCode: number, params: string): string {
  switch (finalCode) {
    case 0x43: { // CUF: ConPTY writes skipped (unchanged) cells this way, usually spaces
      const count = Number.parseInt(params, 10);
      return " ".repeat(Math.min(Number.isFinite(count) && count > 0 ? count : 1, MAX_CURSOR_FORWARD));
    }
    case 0x47: // CHA
    case 0x60: // HPA
      return " ";
    case 0x41: // CUU
    case 0x42: // CUD
    case 0x45: // CNL
    case 0x46: // CPL
    case 0x48: // CUP
    case 0x64: // VPA
    case 0x66: // HVP
    case 0x4a: // ED
      return "\n";
    default:
      return "";
  }
}

function notificationFromOsc(payload: string): string | null {
  const separator = payload.indexOf(";");
  if (separator < 0) return null;
  const command = payload.slice(0, separator);
  const rest = payload.slice(separator + 1);
  if (command === "9") {
    // ConEmu / Windows Terminal reuse OSC 9 with a numeric subcommand (9;4 progress, 9;9 working directory, ...);
    // iTerm2-style notifications carry free text.
    if (/^\d+(?:;|$)/.test(rest)) return null;
    return cleanNotificationText(rest);
  }
  if (command === "777") {
    const [verb, title = "", ...body] = rest.split(";");
    if (verb !== "notify") return null;
    return cleanNotificationText(body.join(";")) ?? cleanNotificationText(title);
  }
  if (command === "99") {
    // Kitty: metadata;payload. Only the final title/body chunk shows a notification; `p=?` is a capability query.
    const metadataEnd = rest.indexOf(";");
    const metadata = metadataEnd < 0 ? rest : rest.slice(0, metadataEnd);
    const body = metadataEnd < 0 ? "" : rest.slice(metadataEnd + 1);
    const fields = new Map(metadata.split(":").map((field): [string, string] => {
      const equals = field.indexOf("=");
      return equals < 0 ? [field, ""] : [field.slice(0, equals), field.slice(equals + 1)];
    }));
    const part = fields.get("p") ?? "title";
    if (part !== "title" && part !== "body") return null;
    if (fields.get("d") === "0") return null;
    const text = fields.get("e") === "1" ? Buffer.from(body, "base64").toString("utf8") : body;
    return cleanNotificationText(text);
  }
  return null;
}

function cleanNotificationText(text: string): string | null {
  const cleaned = text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > NOTIFICATION_MAX_CHARS ? `${cleaned.slice(0, NOTIFICATION_MAX_CHARS - 1)}…` : cleaned;
}

export type TerminalAttentionTrackerOptions = {
  timings?: Partial<TerminalAttentionTimings>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type PendingPrompt = PromptMatch & { visibleUpdates: number; timer: unknown };

type AttentionState = {
  // Agent CLIs have turns; plain shells only report prompts and explicit notifications.
  agent: boolean;
  scan: TerminalScanState;
  // Tail of already-scanned text so prompts split across batches match.
  carry: string;
  // Newest text not yet scanned, bounded to the scan window.
  unscanned: string;
  lastScanAt: number;
  scanTimer: unknown;
  lastInputAt: number;
  lastVisibleAt: number;
  // Set by input (or a launch task): the next busy stretch of output is a turn worth reporting when it ends.
  armed: boolean;
  busySince: number | null;
  settleTimer: unknown;
  pendingPrompt: PendingPrompt | null;
  // Kinds already reported since the last input, so redraws and duplicate signals stay quiet.
  reported: Set<TerminalAttentionKind>;
};

/**
 * Per-terminal attention detection over PTY output. Cheap on the hot path: one pass of an escape-sequence parser per
 * batch, prompt matching throttled to `scanThrottleMs`, and timers that re-arm themselves instead of being reset for
 * every batch.
 */
export class TerminalAttentionTracker {
  private readonly states = new Map<string, AttentionState>();
  private readonly timings: TerminalAttentionTimings;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly onAttention?: (event: TerminalAttentionEvent) => void,
    options: TerminalAttentionTrackerOptions = {},
  ) {
    this.timings = { ...TERMINAL_ATTENTION_TIMINGS, ...options.timings };
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Declares what runs in the terminal. `armed` reports the first turn without waiting for input (a launch task). */
  register(id: string, options: { agent: boolean; armed?: boolean }): void {
    const state = this.state(id);
    state.agent = options.agent;
    state.armed = options.agent && Boolean(options.armed);
  }

  /** Input written to the terminal. Terminal-generated reports (focus, query replies, mouse motion) are ignored. */
  noteInput(id: string, data?: string): void {
    if (data !== undefined && isTerminalReportInput(data)) return;
    const state = this.state(id);
    state.lastInputAt = this.now();
    state.reported.clear();
    this.cancelPrompt(state);
    state.busySince = null;
    if (state.agent) state.armed = true;
  }

  /** Records output; reports through onAttention when a signal is confirmed. */
  observe(id: string, data: string): void {
    if (!data) return;
    const state = this.state(id);
    const now = this.now();
    const result = scanTerminalOutput(state.scan, data);
    if (result.printable) {
      state.lastVisibleAt = now;
      if (state.pendingPrompt) state.pendingPrompt.visibleUpdates += 1;
      if (state.agent && state.armed) {
        if (state.busySince == null && now - state.lastInputAt >= this.timings.inputEchoGraceMs) state.busySince = now;
        if (state.busySince != null) this.armSettle(id, state);
      }
    }
    for (const message of result.notifications) this.report(id, state, classifyNotificationText(message), "notification", message);
    if (result.bells > 0 && now - state.lastInputAt >= this.timings.bellInputGraceMs) this.report(id, state, "update", "bell", null);
    if (result.text) {
      appendUnscanned(state, result.text);
      this.scheduleScan(id, state, now);
    }
  }

  /** A process that ended on its own (not killed by Athena). */
  noteExit(id: string, exitCode: number | null): void {
    this.clear(id);
    const message = exitCode != null && exitCode !== 0 ? `Exited with code ${exitCode}` : null;
    this.onAttention?.({ id, kind: "update", reason: "exit", message });
  }

  clear(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    if (state.scanTimer != null) this.clearTimer(state.scanTimer);
    if (state.settleTimer != null) this.clearTimer(state.settleTimer);
    this.cancelPrompt(state);
    this.states.delete(id);
  }

  private state(id: string): AttentionState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        agent: false,
        scan: createTerminalScanState(),
        carry: "",
        unscanned: "",
        lastScanAt: Number.NEGATIVE_INFINITY,
        scanTimer: null,
        lastInputAt: Number.NEGATIVE_INFINITY,
        lastVisibleAt: Number.NEGATIVE_INFINITY,
        armed: false,
        busySince: null,
        settleTimer: null,
        pendingPrompt: null,
        reported: new Set(),
      };
      this.states.set(id, state);
    }
    return state;
  }

  private report(
    id: string,
    state: AttentionState,
    kind: TerminalAttentionKind,
    reason: TerminalAttentionReason,
    message: string | null,
  ): void {
    if (state.reported.has(kind)) return;
    state.reported.add(kind);
    if (kind === "action") this.cancelPrompt(state);
    this.onAttention?.({ id, kind, reason, message });
  }

  private scheduleScan(id: string, state: AttentionState, now: number): void {
    if (state.scanTimer != null) return;
    const waitMs = state.lastScanAt + this.timings.scanThrottleMs - now;
    if (waitMs <= 0) {
      this.scan(id, state, now);
      return;
    }
    state.scanTimer = this.setTimer(() => {
      state.scanTimer = null;
      if (this.states.get(id) !== state) return;
      this.scan(id, state, this.now());
    }, waitMs);
  }

  private scan(id: string, state: AttentionState, now: number): void {
    state.lastScanAt = now;
    if (!state.unscanned) return;
    const carry = state.carry;
    const text = `${carry}${state.unscanned}`.replace(/\s+/g, " ");
    state.unscanned = "";
    state.carry = text.slice(-TERMINAL_ATTENTION_CARRY_CHARS);
    if (state.reported.has("action") || state.pendingPrompt) return;
    // Matches wholly inside the carried tail were already considered.
    const prompt = matchAttentionPrompt(text, carry.length);
    if (prompt) this.startPromptConfirm(id, state, prompt);
  }

  private startPromptConfirm(id: string, state: AttentionState, prompt: PromptMatch): void {
    const pending: PendingPrompt = { ...prompt, visibleUpdates: 0, timer: null };
    pending.timer = this.setTimer(() => {
      if (this.states.get(id) !== state || state.pendingPrompt !== pending) return;
      state.pendingPrompt = null;
      if (pending.visibleUpdates <= this.timings.promptConfirmMaxUpdates) {
        this.report(id, state, "action", pending.reason, pending.message);
      }
    }, this.timings.promptConfirmMs);
    state.pendingPrompt = pending;
  }

  private cancelPrompt(state: AttentionState): void {
    if (!state.pendingPrompt) return;
    this.clearTimer(state.pendingPrompt.timer);
    state.pendingPrompt = null;
  }

  // One timer per busy stretch: when it fires early it re-arms for the remaining quiet time.
  private armSettle(id: string, state: AttentionState): void {
    if (state.settleTimer != null) return;
    const check = () => {
      state.settleTimer = null;
      if (this.states.get(id) !== state) return;
      const quietMs = this.now() - state.lastVisibleAt;
      if (quietMs < this.timings.turnSettleMs) {
        state.settleTimer = this.setTimer(check, this.timings.turnSettleMs - quietMs);
        return;
      }
      this.completeTurn(id, state);
    };
    state.settleTimer = this.setTimer(check, this.timings.turnSettleMs);
  }

  private completeTurn(id: string, state: AttentionState): void {
    const busySince = state.busySince;
    state.busySince = null;
    if (busySince == null || !state.armed) return;
    // Stopped at a prompt: that was already reported (or is being confirmed) as needing the user.
    if (state.pendingPrompt || state.reported.has("action")) return;
    // A short burst is a redraw or a menu, not a turn; stay armed for the real one.
    if (state.lastVisibleAt - busySince < this.timings.turnMinBusyMs) return;
    state.armed = false;
    this.report(id, state, "update", "turn-complete", null);
  }
}

function appendUnscanned(state: AttentionState, text: string): void {
  if (text.length >= TERMINAL_ATTENTION_SCAN_MAX_CHARS) {
    state.unscanned = text.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS);
    return;
  }
  const combined = `${state.unscanned}${text}`;
  // Amortized trim: let the rope grow to twice the window before flattening.
  state.unscanned = combined.length > TERMINAL_ATTENTION_SCAN_MAX_CHARS * 2
    ? combined.slice(-TERMINAL_ATTENTION_SCAN_MAX_CHARS)
    : combined;
}
