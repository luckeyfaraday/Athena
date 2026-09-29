/**
 * Terminal output -> chat bubbles, for the chat view (EmbeddedChatTerminal).
 *
 * Pure module (no React/DOM) so `node --test` can import it directly.
 *
 * Pipeline, per turn segment (the output between two prompt markers):
 *   raw PTY text
 *     -> AnsiStripper: streaming VT escape remover (CSI / OSC / DCS / ESC x)
 *     -> line splitter with the legacy `\r\n -> \n`, `\r+ -> \n` semantics
 *     -> per-line cleanup + classification (cached per distinct line)
 *     -> stateful filter (startup panels, recall blocks) + blank-line collapse
 *     -> transcript (last MAX_TRANSCRIPT_CHARS chars) -> chat blocks.
 *
 * `ChatTranscriptParser` runs that pipeline incrementally: appended text only
 * advances the state machines, finalized lines are classified once and kept
 * (bounded), and building a view only re-classifies the current partial line.
 * `parseChatTranscript` is the equivalent one-shot parse; the tests assert both
 * produce identical blocks for arbitrary chunkings of the same stream.
 */

export type ChatBlockRole = "user" | "assistant" | "status";

export type ChatBlock = {
  id: string;
  role: ChatBlockRole;
  label: string;
  text: string;
  /** Provider-recorded Markdown; terminal-scraped text is plain and never set this. */
  markdown?: boolean;
};

/** Structurally compatible with chat-mode's SentPromptBlock. */
export type ChatPrompt = ChatBlock & { role: "user"; marker: number };

export const MAX_TRANSCRIPT_CHARS = 14_000;
export const MAX_OUTPUT_BLOCKS = 100;
export const MAX_CHAT_BLOCKS = 200;
/** A single (newline-free) line keeps at most its last MAX_LINE_CHARS chars. */
export const MAX_LINE_CHARS = 64_000;
/** Raw PTY text kept around to re-split a segment when a prompt marker lands in the past. */
export const RAW_RETAIN_CHARS = 32_000;
/** How much of a (re)attach snapshot is parsed; matches the legacy 80KB window. */
export const SNAPSHOT_PARSE_CHARS = 80_000;

const LINE_SLACK_CHARS = 16_384;
const MAX_SEQUENCE_CHARS = 4_096;
const MAX_STRING_PAYLOAD_CHARS = 8_192;
const CHECKPOINT_INTERVAL_CHARS = 2_048;
const LINE_INFO_CACHE_LIMIT = 4_096;
const LINE_INFO_CACHEABLE_CHARS = 512;
const EMPTY_BLOCKS: ChatBlock[] = [];

// ---------------------------------------------------------------------------
// Streaming ANSI / VT escape stripper
// ---------------------------------------------------------------------------

type TextSink = {
  text(value: string): void;
  cr(): void;
  /** `offsetAfter` is the index just past the LF in the written chunk, or -1 while re-feeding. */
  lf(offsetAfter: number): void;
};

const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI = 3;
const STRING = 4;
const STRING_ESCAPE = 5;

/**
 * Removes escape sequences from a stream written in arbitrary chunks; state
 * carries across `write` calls so chunk boundaries never change the output.
 *
 * Same results as the legacy regex cascade for well-formed CSI, BEL-terminated
 * OSC, charset designators, ESC + [@-_] and C0 controls. Differences are fixes:
 * ST-terminated OSC/DCS/APC strings end at their terminator (the legacy greedy
 * regex swallowed text up to the next BEL anywhere in the buffer), ESC 7/8/=/>
 * and ESC # 8 no longer leak "7", "8", "#8" into the text, and a sequence that
 * is still arriving is hidden instead of flashing its parameters. Malformed
 * sequences still surface their parameters as text, as before.
 */
class AnsiStripper {
  state = GROUND;
  seq = "";
  csiIntermediate = false;
  csiC1 = false;
  payloadOverflow = false;

  reset(): void {
    this.state = GROUND;
    this.seq = "";
    this.csiIntermediate = false;
    this.csiC1 = false;
    this.payloadOverflow = false;
  }

  write(text: string, sink: TextSink, refeed = false): void {
    const n = text.length;
    let i = 0;
    while (i < n) {
      const state = this.state;
      if (state === GROUND) {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c >= 0x20 ? c === 0x7f || c === 0x9b : c !== 0x09) break;
          j++;
        }
        if (j > i) sink.text(j - i === n ? text : text.slice(i, j));
        if (j >= n) return;
        const c = text.charCodeAt(j);
        i = j + 1;
        if (c === 0x0a) sink.lf(refeed ? -1 : i);
        else if (c === 0x0d) sink.cr();
        else if (c === 0x1b) this.state = ESCAPE;
        else if (c === 0x9b) this.beginCsi(true);
        // Any other C0 control or DEL is dropped.
        continue;
      }

      if (state === ESCAPE) {
        const c = text.charCodeAt(i);
        if (c === 0x5b) {
          this.beginCsi(false);
          i++;
        } else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) {
          // OSC, DCS, SOS, PM, APC: string terminated by BEL or ST.
          this.state = STRING;
          this.seq = "";
          this.payloadOverflow = false;
          i++;
        } else if (c >= 0x20 && c <= 0x2f) {
          this.state = ESCAPE_INTERMEDIATE;
          this.seq = "";
        } else if (c >= 0x30 && c <= 0x7e) {
          this.state = GROUND;
          i++;
        } else if (c === 0x1b) {
          i++;
        } else {
          // Lone ESC: drop it and reprocess this char as text/control.
          this.state = GROUND;
        }
        continue;
      }

      if (state === CSI) {
        const start = i;
        let intermediate = this.csiIntermediate;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c >= 0x20 && c <= 0x2f) intermediate = true;
          else if (c < 0x30 || c > 0x3f || intermediate) break;
          i++;
        }
        const room = MAX_SEQUENCE_CHARS - this.seq.length;
        if (i - start > room) {
          i = start + room;
        } else if (i >= n) {
          this.seq += text.slice(start, i);
          this.csiIntermediate = intermediate;
          return;
        } else {
          const c = text.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) {
            this.state = GROUND;
            this.seq = "";
            i++;
            continue;
          }
        }
        // Malformed: surface the parameters as text and reprocess this char.
        const collected = (this.csiC1 ? "\x9b" : "") + this.seq + text.slice(start, i);
        this.state = GROUND;
        this.seq = "";
        if (collected) sink.text(collected);
        continue;
      }

      if (state === ESCAPE_INTERMEDIATE) {
        const start = i;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c < 0x20 || c > 0x2f) break;
          i++;
        }
        const room = MAX_SEQUENCE_CHARS - this.seq.length;
        if (i - start > room) {
          i = start + room;
        } else if (i >= n) {
          this.seq += text.slice(start, i);
          return;
        } else {
          const c = text.charCodeAt(i);
          if (c >= 0x30 && c <= 0x7e) {
            this.state = GROUND;
            this.seq = "";
            i++;
            continue;
          }
        }
        const collected = this.seq + text.slice(start, i);
        this.state = GROUND;
        this.seq = "";
        if (collected) sink.text(collected);
        continue;
      }

      if (state === STRING) {
        const start = i;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === 0x07 || c === 0x1b || c === 0x0a) break;
          i++;
        }
        if (i > start && !this.payloadOverflow) {
          if (this.seq.length + (i - start) > MAX_STRING_PAYLOAD_CHARS) {
            this.payloadOverflow = true;
            this.seq = "";
          } else {
            this.seq += text.slice(start, i);
          }
        }
        if (i >= n) return;
        const c = text.charCodeAt(i);
        if (c === 0x07) {
          this.state = GROUND;
          this.seq = "";
          this.payloadOverflow = false;
          i++;
        } else if (c === 0x1b) {
          this.state = STRING_ESCAPE;
          i++;
        } else {
          // LF inside a string: it was never a real sequence; show its payload.
          this.abortString(sink);
        }
        continue;
      }

      // STRING_ESCAPE
      if (text.charCodeAt(i) === 0x5c) {
        this.state = GROUND;
        this.seq = "";
        this.payloadOverflow = false;
        i++;
        continue;
      }
      this.abortString(sink);
      this.write("\x1b", sink, true);
    }
  }

  private beginCsi(c1: boolean): void {
    this.state = CSI;
    this.seq = "";
    this.csiIntermediate = false;
    this.csiC1 = c1;
  }

  private abortString(sink: TextSink): void {
    const payload = this.payloadOverflow ? "" : this.seq;
    this.state = GROUND;
    this.seq = "";
    this.payloadOverflow = false;
    if (payload) this.write(payload, sink, true);
  }
}

class StringSink implements TextSink {
  parts: string[] = [];
  text(value: string): void { this.parts.push(value); }
  cr(): void { this.parts.push("\r"); }
  lf(): void { this.parts.push("\n"); }
}

export function stripAnsi(value: string): string {
  const sink = new StringSink();
  new AnsiStripper().write(value, sink);
  return sink.parts.join("");
}

// ---------------------------------------------------------------------------
// Per-line cleanup and classification
// ---------------------------------------------------------------------------

const CURSOR_POSITION_REMNANT = /\[[0-9]+;[0-9]+H/g;
const CURSOR_MOVE_REMNANT = /\[[0-9]+[A-Z]/g;
const BRAILLE_SPINNER = /[\u2800-\u28ff]/g;

function cleanTerminalLine(line: string): string {
  let out = line;
  if (out.indexOf("[") !== -1) out = out.replace(CURSOR_POSITION_REMNANT, "").replace(CURSOR_MOVE_REMNANT, "");
  // (Trailing whitespace is removed by stripDecorativeBorders.)
  return out.replace(BRAILLE_SPINNER, "");
}

function stripDecorativeBorders(line: string): string {
  // Preserve code indentation and Markdown tables. Only strip actual TUI walls.
  const trimmed = line.trimEnd();
  const first = trimmed.search(/\S/);
  let start = first >= 0 && "│┃║".includes(trimmed[first]) ? first + 1 : 0;
  if (start && trimmed[start] === " ") start++;
  const end = "│┃║".includes(trimmed.at(-1) ?? " ") ? trimmed.length - 1 : trimmed.length;
  return trimmed.slice(start, end).trimEnd();
}

function normalizePromptPrefix(line: string): string {
  return line
    .replace(/^[\s⚕✦●•·*_\-│┃║]+/, "")
    .replace(/^[›❯>$#]\s*/, "")
    .trim();
}

function normalizeChatComparable(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim()
    .toLowerCase();
}

function anchoredUnion(patterns: RegExp[]): RegExp {
  return new RegExp(`^(?:${patterns.map((pattern) => pattern.source).join("|")})`, "i");
}

const RECALL_BLOCK_START = /^[›❯]?\s*You are running inside an embedded Context Workspace terminal\./i;
const RECALL_BLOCK_END = /^(?:Working \(|Ready\.|Welcome to Hermes Agent|[›❯]\s*)/i;
const STARTUP_PANEL_START = anchoredUnion([
  /Available Tools\b/,
  /MCP Servers\b/,
  /Available Skills\b/,
  /\[Context Workspace\]\s+\w+\s+ready\.?$/,
  /\[Context Workspace\]\s+(?:Codex|OpenCode|Claude)\s+(?:Hermes prompt|Athena context):/,
]);
const STARTUP_PANEL_END = /^(?:Welcome to Hermes Agent|✦?\s*Tip:|Working \(|Ready\.|[›❯]\s*)/i;

const THINKING_WORDS = /(?:reflecting|reasoning|ruminating|thinking|working|formulating|mulling|cogitating)/;
const THINKING_PATTERNS = [
  new RegExp(`\\S*[\\s)]*${THINKING_WORDS.source}\\.{0,3}$`),
  new RegExp(`\\(.*\\)\\s*${THINKING_WORDS.source}\\.{0,3}$`),
];
const THINKING_LINE = anchoredUnion(THINKING_PATTERNS);

/**
 * Chrome patterns the legacy filters tested against the prompt-normalized line
 * twice over (isTransientControlLine, isThinkingLine, most of isLowValueFragment
 * and the first isRecallInjectionLine pattern re-normalize their argument).
 */
const DOUBLE_NORMALIZED_CHROME = [
  // isTransientControlLine
  /msg=interrupt\s+·?\s*\/queue\s+·?\s*\/bg\s+·?\s*\/steer\s+·?\s*Ctrl\+C cancel/,
  /msg=interrupt\s+\/queue\s+\/bg\s+\/steer/,
  /Initializing agent/,
  /(?:ctx|tokens?)\s/,
  /\d+(?:\.\d+)?[KMB]?\s*\(\d+%\)/,
  /Starting MCP servers/,
  /Working\s*\(/,
  /Explore\s*\(/,
  /Build\s*·/,
  /Parent up\s+Prev left\s+Next right/,
  /\d+s\s*·\s*esc to interrupt/,
  /esc to interrupt/,
  /\]?\d+;rgb:[0-9a-f/]+$/,
  // isThinkingLine
  ...THINKING_PATTERNS,
  // isLowValueFragment
  /[\s.·•*_-]{1,12}$/,
  // isRecallInjectionLine (first pattern)
  /You are running inside an embedded Context Workspace terminal\./,
];

/** Chrome patterns the legacy filters tested against the once-normalized line. */
const SINGLE_NORMALIZED_CHROME = [
  // isStartupChromeLine
  /\[Context Workspace\]\s+\w+\s+ready\.?$/,
  /\[Context Workspace\]\s+(?:Codex|OpenCode|Claude)\s+(?:Hermes prompt|Athena context):/,
  /\[Context Workspace\]\s+OpenCode baseline binary selected/,
  /Available Tools\b/,
  /MCP Servers\b/,
  /Available Skills\b/,
  /\(?and \d+ more toolsets/,
  /\d+\s+tools\s+·\s+\d+\s+skills/,
  /Welcome to Hermes Agent/,
  /✦?\s*Tip:/,
  /[-•]?\s*Starting MCP servers/,
  /Working \(/,
  /Ready\.$/,
  /[_>]\s+OpenAI Codex/,
  /OpenCode\b/,
  /model:\s+/,
  /directory:\s+/,
  /cwd:\s+/,
  /provider:\s+/,
  /session:\s+/,
  /\/\w+\s+to\s+/,
  /Tip:\s+/,
  /gpt-[\w.-]+\s+/,
  /MiniMax-[\w.-]+\s+·/,
  /Session:\s+\d{8}_/,
  /(?:browser|browser-cdp|clarify|code_execution|computer_use|cronjob|delegation|discord|email|gaming|general|github|hermes-agent|mcp|media|mlops|note-taking|productivity|projects|research|software-development|trading):\s+/,
  // isRecallInjectionLine (remaining patterns)
  /Agent:\s+/,
  /Pane:\s+/,
  /Workspace:\s+/,
  /Context Workspace refreshed Hermes recall/,
  /Recall cache path:/,
  /Use the recall cache as short-lived project context/,
  /Hermes session recall is attached below/,
  /# Hermes recall for Context Workspace/,
  /Generated by Context Workspace/,
  /## (?:Current workspace|Operating contract|Native agent sessions)$/,
  /- Project:\s+/,
  /- Task hint:\s+/,
  /- Backend:\s+/,
  /- Hermes owns durable memory/,
  /- Context Workspace owns app-side tools/,
  /- Agents should consume this generated recall/,
  /Native agent sessions for this workspace:/,
  /-\s+\d{4}-\d{2}-\d{2}T.*\[(?:codex|opencode|athena|claude|hermes),/,
  /resume:\s+`?(?:codex|opencode|athena-code|claude|hermes)\s+/,
  /Hermes memory is attached below/,
  /No Hermes memory entries are available\./,
  // isLowValueFragment (tested on the once-normalized line)
  /etc\.?\s+in\s+config\.ya?ml\.?$/,
];

const DOUBLE_NORMALIZED_CHROME_LINE = anchoredUnion(DOUBLE_NORMALIZED_CHROME);
const SINGLE_NORMALIZED_CHROME_LINE = anchoredUnion(SINGLE_NORMALIZED_CHROME);
const ANY_CHROME_LINE = anchoredUnion([...DOUBLE_NORMALIZED_CHROME, ...SINGLE_NORMALIZED_CHROME]);

const BOX_DRAWING_CHARS = "╭╮╯╰│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬━┃┏┓┗┛┣┫┳┻╋";
const BOX_DRAWING_TABLE = new Uint8Array(0x80);
for (let index = 0; index < BOX_DRAWING_CHARS.length; index++) {
  BOX_DRAWING_TABLE[BOX_DRAWING_CHARS.charCodeAt(index) - 0x2500] = 1;
}

function isBoxDrawingLine(line: string): boolean {
  let count = 0;
  for (let index = 0; index < line.length; index++) {
    const offset = line.charCodeAt(index) - 0x2500;
    if (offset >= 0 && offset < 0x80 && BOX_DRAWING_TABLE[offset]) count++;
  }
  return count > 0 && count / Math.max(line.length, 1) > 0.18;
}

/**
 * Transient chrome, thinking/low-value fragments, box drawing, startup chrome
 * and recall injection — the legacy isMeaningfulChatLine exclusions minus
 * redraw noise. `line` is the once prompt-normalized line.
 */
function isChromeLine(line: string): boolean {
  const twice = normalizePromptPrefix(line);
  if (twice === line) {
    if (ANY_CHROME_LINE.test(line)) return true;
  } else if (DOUBLE_NORMALIZED_CHROME_LINE.test(twice) || SINGLE_NORMALIZED_CHROME_LINE.test(line)) {
    return true;
  }
  return isBoxDrawingLine(line);
}

const REDRAW_KEYWORDS = /StartingMCP|openaiDeveloperDocs|Working\(|esc to interrupt/i;
const START_TOKENS = /sta|mcp|server/gi;

function hasRepeatedRun(value: string, runLength: number): boolean {
  let run = 1;
  for (let index = 1; index < value.length; index++) {
    if (value.charCodeAt(index) === value.charCodeAt(index - 1)) {
      if (++run >= runLength) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function countStartTokens(value: string): number {
  START_TOKENS.lastIndex = 0;
  let count = 0;
  while (count < 3 && START_TOKENS.exec(value)) count++;
  START_TOKENS.lastIndex = 0;
  return count;
}

/**
 * Legacy: `/(?:Sta|Start|Starti|Starting|MCP|server|servers).*(?:…).*(?:…)/i`,
 * which backtracks polynomially on long lines. The tokens can never overlap,
 * so "three in order" is "three occurrences" within a stretch that `.` can
 * span (no U+2028/U+2029).
 */
function hasThreeStartTokens(line: string): boolean {
  if (line.indexOf("\u2028") === -1 && line.indexOf("\u2029") === -1) return countStartTokens(line) >= 3;
  return line.split(/[\u2028\u2029]/).some((piece) => countStartTokens(piece) >= 3);
}

function isRedrawNoiseLine(line: string): boolean {
  if (line.length < 9) return false;
  const compact = line.replace(/\s+/g, "");
  if (compact.length > 80 && REDRAW_KEYWORDS.test(compact)) return true;
  // Legacy `/(.)\1{8,}/`: nine identical consecutive code units.
  if (hasRepeatedRun(compact, 9)) return true;
  return hasThreeStartTokens(line);
}

function isMeaningfulChatLine(line: string): boolean {
  const trimmed = normalizePromptPrefix(line.trim());
  if (!trimmed) return true;
  return !isChromeLine(trimmed) && !isRedrawNoiseLine(trimmed);
}

const STATUS_LINE = /^\[process exited:|\b(?:error|failed|exception|traceback|permission denied|not found)\b/i;
const EMPTY_PROMPT_LINE = /^(?:[$#>]\s*)?$/;
const SHELL_PROMPT_LINE = /^[\w.-]+@[\w.-]+:[^$#]*[$#]\s*$/;
const CURRENT_STATUS_LINE = /^Current status:\s*$/i;

function isStatusLine(line: string): boolean {
  return STATUS_LINE.test(line);
}

const ECHO_MARK = /^[›❯>]\s*/;
/** What Claude-style TUIs echo in place of pasted text or attached images. */
const INPUT_PLACEHOLDER = /^\[(?:pasted text|image) #\d+/i;

function echoFragment(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Marks a TUI's echo of the submitted prompt: a line with an input marker
 * (`›`, `❯`, `>`) that starts the prompt (or shows a paste/image placeholder)
 * plus the lines that directly continue it, as wrapped or multi-line prompts
 * are echoed; or a line equal to the whole prompt. Only an unbroken run from
 * such a start is hidden, so replies that mention, quote or repeat parts of
 * the prompt elsewhere stay visible.
 */
function promptEchoMask(lines: readonly string[], promptText: string | undefined): boolean[] | null {
  const prompt = promptText ? echoFragment(promptText) : "";
  if (!prompt) return null;
  const mask = new Array<boolean>(lines.length).fill(false);
  let echoed: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      mask[index] = echoed !== null;
      continue;
    }
    const marked = ECHO_MARK.test(trimmed);
    const text = echoFragment(marked ? trimmed.replace(ECHO_MARK, "") : trimmed);
    if (echoed !== null && echoed.length < prompt.length) {
      // Wrapping may split the prompt at a space or inside a word.
      const next: string | undefined = [`${echoed} ${text}`, echoed + text].find((candidate) => prompt.startsWith(candidate));
      if (next) {
        echoed = next;
        mask[index] = true;
        continue;
      }
    }
    if (text && (marked ? prompt.startsWith(text) || INPUT_PLACEHOLDER.test(text) : text === prompt)) {
      echoed = text;
      mask[index] = true;
      continue;
    }
    echoed = null;
  }
  return mask;
}

/** `normalized` is normalizePromptPrefix(line); `promptComparable` is the normalized prompt text or "". */
function isPromptEchoLine(line: string, normalized: string, promptComparable: string): boolean {
  if (EMPTY_PROMPT_LINE.test(normalized)) return true;
  if (promptComparable && normalizeChatComparable(normalized) === promptComparable) return true;
  const trimmed = line.trim();
  if (trimmed.startsWith("›") || trimmed.startsWith("❯")) return true;
  if (line.indexOf("@") !== -1 && SHELL_PROMPT_LINE.test(line)) return true;
  return CURRENT_STATUS_LINE.test(normalized);
}

// Line flags, computed once per distinct raw line.
const STARTS_RECALL = 1;
const ENDS_RECALL = 2;
const STARTS_PANEL = 4;
const ENDS_PANEL = 8;
const MEANINGFUL = 16;

type LineInfo = { cleaned: string; flags: number };

const lineInfoCache = new Map<string, LineInfo>();

function classifyLine(raw: string): LineInfo {
  const cacheable = raw.length <= LINE_INFO_CACHEABLE_CHARS;
  if (cacheable) {
    const hit = lineInfoCache.get(raw);
    if (hit) return hit;
  }
  const cleaned = stripDecorativeBorders(cleanTerminalLine(raw));
  const trimmed = cleaned.trim();
  let flags = 0;
  if (RECALL_BLOCK_START.test(trimmed)) flags |= STARTS_RECALL;
  if (RECALL_BLOCK_END.test(trimmed)) flags |= ENDS_RECALL;
  if (STARTUP_PANEL_START.test(trimmed)) flags |= STARTS_PANEL;
  if (STARTUP_PANEL_END.test(trimmed)) flags |= ENDS_PANEL;
  if (isMeaningfulChatLine(cleaned)) flags |= MEANINGFUL;
  const info = { cleaned, flags };
  if (cacheable) {
    if (lineInfoCache.size >= LINE_INFO_CACHE_LIMIT) lineInfoCache.clear();
    lineInfoCache.set(raw, info);
  }
  return info;
}

type FilterState = { skipRecall: boolean; skipPanel: boolean; lastKeptNonBlank: boolean };

/**
 * One step of the legacy filterMeaningfulChatLines + blank-line collapse.
 * Returns the line to keep, or null.
 */
function filterLine(state: FilterState, info: LineInfo): string | null {
  const flags = info.flags;
  if (flags & STARTS_RECALL) {
    state.skipRecall = true;
    return null;
  }
  if (state.skipRecall) {
    if (!(flags & ENDS_RECALL)) return null;
    state.skipRecall = false;
  }
  if (flags & STARTS_PANEL) {
    state.skipPanel = true;
    return null;
  }
  if (state.skipPanel) {
    if (flags & ENDS_PANEL) state.skipPanel = false;
    return null;
  }
  if (!(flags & MEANINGFUL)) return null;
  if (!info.cleaned) {
    if (!state.lastKeptNonBlank) return null;
    state.lastKeptNonBlank = false;
    return "";
  }
  state.lastKeptNonBlank = true;
  return info.cleaned;
}

function limitLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(-MAX_LINE_CHARS) : line;
}

// ---------------------------------------------------------------------------
// Transcript -> blocks
// ---------------------------------------------------------------------------

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

function splitOutputIntoChunks(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/\n{3,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => splitLargeChunk(chunk, 2600));
}

function isRawFallbackLine(line: string, promptComparable: string): boolean {
  const trimmed = normalizePromptPrefix(line.trim());
  if (!trimmed) return false;
  if (isStatusLine(trimmed)) return false;
  if (isPromptEchoLine(line, normalizePromptPrefix(line), promptComparable)) return false;
  return !isChromeLine(trimmed);
}

function rawTranscriptFallback(lines: string[], promptComparable: string, echo: readonly boolean[] | null): string {
  return lines
    .map(stripDecorativeBorders)
    .filter((line, index) => !echo?.[index] && isRawFallbackLine(line, promptComparable))
    .join("\n")
    .trim()
    .slice(-4000);
}

const BODY_STATUS = 1;
const BODY_HIDDEN = 2;
const BODY_TEXT = 3;

/** Status line, hidden (prompt echo / thinking), or body text. */
function bodyLineKind(line: string, promptComparable: string): number {
  if (isStatusLine(line)) return BODY_STATUS;
  const normalized = normalizePromptPrefix(line);
  if (isPromptEchoLine(line, normalized, promptComparable) || THINKING_LINE.test(normalized)) return BODY_HIDDEN;
  return BODY_TEXT;
}

/**
 * `kinds` optionally caches bodyLineKind per line for one promptText; the
 * transcript mostly repeats between views, only its tail changes.
 */
function segmentBlocks(
  transcript: string,
  segmentIndex: number,
  promptText: string | undefined,
  title: string,
  kinds?: Map<string, number>,
): ChatBlock[] {
  const promptComparable = promptText ? normalizeChatComparable(promptText) : "";
  const lines = transcript.split("\n");
  const echo = promptEchoMask(lines, promptText);
  const statusLines: string[] = [];
  const bodyLines: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (echo?.[index]) continue;
    const line = lines[index];
    let kind = kinds?.get(line);
    if (kind === undefined) {
      kind = bodyLineKind(line, promptComparable);
      kinds?.set(line, kind);
    }
    if (kind === BODY_STATUS) statusLines.push(line);
    else if (kind === BODY_TEXT) bodyLines.push(line);
  }
  const body = bodyLines.join("\n").trim();

  const blocks: ChatBlock[] = [];
  statusLines.slice(-2).forEach((line, index) => {
    blocks.push({ id: `status-${segmentIndex}-${index}-${line}`, role: "status", label: "Status", text: line });
  });

  const chunks = splitOutputIntoChunks(body);
  if (chunks.length === 0) {
    const fallback = rawTranscriptFallback(lines, promptComparable, echo);
    if (fallback) {
      blocks.push({
        id: `fallback-status-${segmentIndex}-${fallback.slice(0, 32)}`,
        role: "status",
        label: "Fallback",
        text: "Raw transcript shown because chat parsing could not confidently group this output.",
      });
      blocks.push({ id: `fallback-${segmentIndex}-${fallback.slice(0, 32)}`, role: "assistant", label: title, text: fallback });
    }
    return blocks;
  }
  chunks.forEach((chunk, index) => {
    blocks.push({ id: `output-${segmentIndex}-${index}-${chunk.slice(0, 32)}`, role: "assistant", label: title, text: chunk });
  });
  return blocks;
}

function interleaveChatTurns(outputBlocks: ChatBlock[], prompts: readonly ChatPrompt[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const outputBySegment = new Map<number, ChatBlock[]>();

  for (const block of outputBlocks) {
    const match = /^(?:output|status|fallback-status|fallback)-(\d+)-/.exec(block.id);
    const segment = Number(match?.[1] ?? 0);
    const list = outputBySegment.get(segment);
    if (list) list.push(block);
    else outputBySegment.set(segment, [block]);
  }

  if (prompts.length === 0) blocks.push(...(outputBySegment.get(0) ?? []));
  prompts.forEach((promptBlock, index) => {
    blocks.push(promptBlock);
    blocks.push(...(outputBySegment.get(index + 1) ?? []));
  });

  for (const [segment, segmentBlocksList] of outputBySegment) {
    if (segment > prompts.length) blocks.push(...segmentBlocksList);
  }
  return blocks;
}

/** Segment j starts at the running max of markers[0..j-1], never before `from`. */
function segmentStarts(markers: readonly number[], from: number): number[] {
  const starts = [from];
  let bound = from;
  for (const marker of markers) {
    if (Number.isFinite(marker) && marker > bound) bound = marker;
    starts.push(bound);
  }
  return starts;
}

// ---------------------------------------------------------------------------
// One-shot reference parse
// ---------------------------------------------------------------------------

function filterMeaningfulChatLines(lines: string[]): string[] {
  const filtered: string[] = [];
  let skippingStartupPanel = false;
  let skippingRecallBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (RECALL_BLOCK_START.test(trimmed)) {
      skippingRecallBlock = true;
      continue;
    }
    if (skippingRecallBlock) {
      if (RECALL_BLOCK_END.test(trimmed)) skippingRecallBlock = false;
      else continue;
    }
    if (STARTUP_PANEL_START.test(trimmed)) {
      skippingStartupPanel = true;
      continue;
    }
    if (skippingStartupPanel) {
      if (STARTUP_PANEL_END.test(trimmed)) skippingStartupPanel = false;
      continue;
    }
    if (isMeaningfulChatLine(line)) filtered.push(line);
  }
  return filtered;
}

/** One-shot transcript of a single segment (the legacy normalizeTerminalText). */
export function normalizeTerminalText(value: string): string {
  const lines = stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r+/g, "\n")
    .split("\n")
    .map((line) => stripDecorativeBorders(cleanTerminalLine(limitLine(line))));
  return filterMeaningfulChatLines(lines)
    .filter((line, index, all) => line.trim() || all[index - 1]?.trim())
    .join("\n")
    .trim()
    .slice(-MAX_TRANSCRIPT_CHARS);
}

/**
 * Non-incremental parse of a whole buffer. Same output as feeding the buffer
 * to a ChatTranscriptParser in any number of chunks.
 */
export function parseChatTranscript(value: string, prompts: readonly ChatPrompt[], title: string): ChatBlock[] {
  const starts = segmentStarts(prompts.map((prompt) => prompt.marker), 0);
  const all: ChatBlock[] = [];
  starts.forEach((start, index) => {
    const from = Math.min(start, value.length);
    const to = index + 1 < starts.length ? Math.min(starts[index + 1], value.length) : value.length;
    const transcript = normalizeTerminalText(value.slice(from, to));
    if (transcript) all.push(...segmentBlocks(transcript, index, prompts[index - 1]?.text, title));
  });
  return interleaveChatTurns(all.slice(-MAX_OUTPUT_BLOCKS), prompts).slice(-MAX_CHAT_BLOCKS);
}

// ---------------------------------------------------------------------------
// Incremental parser
// ---------------------------------------------------------------------------

type Checkpoint = {
  pos: number;
  keptCount: number;
  skipRecall: boolean;
  skipPanel: boolean;
  lastKeptNonBlank: boolean;
};

type SegmentLimits = { keepLowChars: number; keepHighChars: number };

/** Incremental state for one turn segment; also the stripper's TextSink. */
class TranscriptSegment implements TextSink {
  readonly start: number;
  readonly enabled: boolean;
  readonly limits: SegmentLimits;
  pos: number;
  stripper = new AnsiStripper();
  chunkBase = 0;
  partial = "";
  pendingCR = 0;
  /** Filtered, blank-collapsed finalized lines (front-trimmed; see keptBase). */
  kept: string[] = [];
  keptBase = 0;
  keptChars = 0;
  filter: FilterState = { skipRecall: false, skipPanel: false, lastKeptNonBlank: false };
  revision = 0;
  checkpoints: Checkpoint[] = [];

  private cacheValid = false;
  private cachedRevision = -1;
  private cachedTail: string[] = [];
  private cachedTranscript = "";
  private cachedIndex = -1;
  private cachedPrompt: string | undefined = undefined;
  private cachedTitle = "";
  private cachedBlocks: ChatBlock[] = EMPTY_BLOCKS;
  private lineKinds = new Map<string, number>();
  private lineKindsPrompt: string | undefined = undefined;

  constructor(start: number, enabled: boolean, limits: SegmentLimits) {
    this.start = start;
    this.pos = start;
    this.enabled = enabled;
    this.limits = limits;
    if (enabled) this.checkpoints.push(this.checkpointAt(start));
  }

  feed(text: string, at: number): void {
    this.pos = at + text.length;
    if (!this.enabled || !text) return;
    this.chunkBase = at;
    this.stripper.write(text, this);
  }

  /** The stream skipped ahead: drop any half-parsed sequence and partial line. */
  discontinuity(at: number): void {
    this.pos = at;
    this.stripper.reset();
    this.partial = "";
    this.pendingCR = 0;
    this.checkpoints = [];
  }

  text(value: string): void {
    if (this.pendingCR) {
      this.pendingCR = 0;
      this.commitPartial();
    }
    const partial = this.partial + value;
    this.partial = partial.length > MAX_LINE_CHARS + LINE_SLACK_CHARS ? partial.slice(-MAX_LINE_CHARS) : partial;
  }

  cr(): void {
    if (this.pendingCR < 2) this.pendingCR++;
  }

  lf(offsetAfter: number): void {
    // "\n" and "\r\n" end one line; "\r\r+\n" ends two (legacy regex semantics).
    const doubled = this.pendingCR >= 2;
    this.pendingCR = 0;
    this.commitPartial();
    if (doubled) this.commitLine("");
    if (offsetAfter >= 0) this.maybeCheckpoint(this.chunkBase + offsetAfter);
  }

  private commitPartial(): void {
    const line = this.partial;
    this.partial = "";
    this.commitLine(line);
  }

  private commitLine(raw: string): void {
    const kept = filterLine(this.filter, classifyLine(limitLine(raw)));
    if (kept === null) return;
    this.kept.push(kept);
    this.keptChars += kept.length + 1;
    this.revision++;
    if (this.keptChars > this.limits.keepHighChars) this.trimKept();
  }

  private trimKept(): void {
    let drop = 0;
    let chars = this.keptChars;
    while (drop < this.kept.length - 1 && chars - (this.kept[drop].length + 1) >= this.limits.keepLowChars) {
      chars -= this.kept[drop].length + 1;
      drop++;
    }
    if (!drop) return;
    this.kept.splice(0, drop);
    this.keptBase += drop;
    this.keptChars = chars;
    this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.keptCount >= this.keptBase);
  }

  private checkpointAt(pos: number): Checkpoint {
    return {
      pos,
      keptCount: this.keptBase + this.kept.length,
      skipRecall: this.filter.skipRecall,
      skipPanel: this.filter.skipPanel,
      lastKeptNonBlank: this.filter.lastKeptNonBlank,
    };
  }

  private maybeCheckpoint(pos: number): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && pos - last.pos < CHECKPOINT_INTERVAL_CHARS) return;
    this.checkpoints.push(this.checkpointAt(pos));
  }

  pruneCheckpoints(rawStart: number): void {
    let drop = 0;
    while (drop < this.checkpoints.length && this.checkpoints[drop].pos < rawStart) drop++;
    if (drop) this.checkpoints.splice(0, drop);
  }

  /** Latest checkpoint at or before `at` whose raw text is still retained. */
  checkpointBefore(at: number, rawStart: number): Checkpoint | null {
    for (let index = this.checkpoints.length - 1; index >= 0; index--) {
      const checkpoint = this.checkpoints[index];
      if (checkpoint.pos > at) continue;
      return checkpoint.pos >= rawStart && checkpoint.keptCount >= this.keptBase ? checkpoint : null;
    }
    return null;
  }

  restore(checkpoint: Checkpoint): void {
    this.kept.length = checkpoint.keptCount - this.keptBase;
    this.keptChars = this.kept.reduce((sum, line) => sum + line.length + 1, 0);
    this.filter = {
      skipRecall: checkpoint.skipRecall,
      skipPanel: checkpoint.skipPanel,
      lastKeptNonBlank: checkpoint.lastKeptNonBlank,
    };
    this.stripper.reset();
    this.partial = "";
    this.pendingCR = 0;
    this.pos = checkpoint.pos;
    this.checkpoints = this.checkpoints.filter((candidate) => candidate.pos <= checkpoint.pos);
    this.revision++;
  }

  /** Filtered lines for the unfinished tail (partial line, plus the empty line after a trailing CR). */
  private tailLines(): string[] {
    if (!this.enabled) return [];
    const state = { ...this.filter };
    const out: string[] = [];
    const first = filterLine(state, classifyLine(limitLine(this.partial)));
    if (first !== null) out.push(first);
    if (this.pendingCR) {
      const second = filterLine(state, classifyLine(""));
      if (second !== null) out.push(second);
    }
    return out;
  }

  /** `kept ++ tail` joined, trimmed and cut to the last MAX_TRANSCRIPT_CHARS. */
  private transcript(tail: string[]): string {
    const kept = this.kept;
    const count = kept.length + tail.length;
    const at = (index: number) => (index < kept.length ? kept[index] : tail[index - kept.length]);
    let index = count - 1;
    // Trailing blank lines are trimmed (collapse leaves at most one).
    while (index >= 0 && at(index) === "") index--;
    const parts: string[] = [];
    let total = -1;
    while (index >= 0 && total < MAX_TRANSCRIPT_CHARS) {
      const line = at(index);
      parts.push(line);
      total += line.length + 1;
      index--;
    }
    if (!parts.length) return "";
    parts.reverse();
    const joined = parts.join("\n");
    // Kept lines have no leading/trailing whitespace and never start with a
    // blank line, so the legacy trim() only matters for the degenerate case.
    const text = index < 0 && this.keptBase === 0 ? joined.trim() : joined;
    return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
  }

  blocks(index: number, promptText: string | undefined, title: string): ChatBlock[] {
    const tail = this.tailLines();
    const sameText = this.cacheValid && this.cachedRevision === this.revision && sameStrings(tail, this.cachedTail);
    const transcript = sameText ? this.cachedTranscript : this.transcript(tail);
    this.cachedRevision = this.revision;
    this.cachedTail = tail;
    if (
      this.cacheValid
      && transcript === this.cachedTranscript
      && index === this.cachedIndex
      && promptText === this.cachedPrompt
      && title === this.cachedTitle
    ) {
      return this.cachedBlocks;
    }
    if (promptText !== this.lineKindsPrompt || this.lineKinds.size > LINE_INFO_CACHE_LIMIT) {
      this.lineKinds = new Map();
      this.lineKindsPrompt = promptText;
    }
    const blocks = transcript ? segmentBlocks(transcript, index, promptText, title, this.lineKinds) : EMPTY_BLOCKS;
    this.cacheValid = true;
    this.cachedTranscript = transcript;
    this.cachedIndex = index;
    this.cachedPrompt = promptText;
    this.cachedTitle = title;
    this.cachedBlocks = blocks;
    return blocks;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) return false;
  return true;
}

export type ChatTranscriptParserOptions = {
  rawRetainChars?: number;
  snapshotParseChars?: number;
};

/**
 * Incremental chat-view parser for one terminal stream.
 *
 * Positions (`position`, prompt markers) are absolute offsets in the stream
 * since the last `reset`, so they stay valid after the retained raw text is
 * trimmed. Only the segment receiving output does work on `append`; `view`
 * re-classifies just the unfinished last line and reuses cached blocks when
 * nothing visible changed (it returns the same array instance in that case).
 */
export class ChatTranscriptParser {
  private end = 0;
  private rawTail = "";
  private markers: number[] = [];
  private segments: TranscriptSegment[];
  private readonly rawRetainChars: number;
  private readonly snapshotParseChars: number;
  private readonly limits: SegmentLimits;
  private lastView: ChatBlock[] = EMPTY_BLOCKS;
  private lastParts: ChatBlock[][] = [];
  private lastPrompts: readonly ChatPrompt[] | null = null;
  private lastTitle = "";

  constructor(options: ChatTranscriptParserOptions = {}) {
    this.rawRetainChars = Math.max(0, options.rawRetainChars ?? RAW_RETAIN_CHARS);
    this.snapshotParseChars = Math.max(1, options.snapshotParseChars ?? SNAPSHOT_PARSE_CHARS);
    // Keep enough finalized lines that a full transcript can still be cut after
    // a checkpoint restore drops every line parsed from the retained raw text.
    const keepLowChars = MAX_TRANSCRIPT_CHARS + this.rawRetainChars + LINE_SLACK_CHARS + 2_048;
    this.limits = { keepLowChars, keepHighChars: keepLowChars + 16_384 };
    this.segments = [new TranscriptSegment(0, true, this.limits)];
  }

  /** Absolute stream offset of the end of everything appended so far. */
  get position(): number {
    return this.end;
  }

  private get rawStart(): number {
    return this.end - this.rawTail.length;
  }

  /**
   * Replace the stream (attach snapshot / reset payload). `base` is the stream
   * offset of the first char of `text` (see chatStreamEndForBuffer in
   * chat-mode), so prompt markers recorded before a remount keep their
   * meaning. A snapshot holds everything up to "now", so a marker past its end
   * cannot be located; it is placed at the start of the snapshot so the output
   * after that prompt stays visible instead of waiting for a future boundary.
   */
  reset(text: string, markers: readonly number[] = this.markers, base = 0): void {
    this.markers = [...markers];
    this.end = base + text.length;
    this.rawTail = this.retain(text);
    const skipped = Math.max(0, text.length - this.snapshotParseChars);
    const from = base + skipped;
    const layoutMarkers = this.markers.map((marker) => (marker > this.end ? from : marker));
    this.layout(from, skipped > 0 ? text.slice(skipped) : text, layoutMarkers);
  }

  /** The last `count` raw chars (for re-anchoring the stream after a remount). */
  recentRaw(count: number): string {
    return this.rawTail.length > count ? this.rawTail.slice(-count) : this.rawTail;
  }

  append(text: string): void {
    if (!text) return;
    const at = this.end;
    this.end += text.length;
    this.rawTail = this.retain(this.rawTail + text);
    this.route(text, at);
    this.pruneCheckpoints();
  }

  /** `count` chars of output were dropped (overflow); positions still advance. */
  skip(count: number): void {
    if (count <= 0) return;
    this.end += count;
    this.rawTail = "";
    const segment = this.segmentAt(this.end);
    segment.discontinuity(this.end);
  }

  /**
   * Apply prompt markers. Appending markers (a new prompt) and dropping the
   * oldest ones (history cap) are incremental; any other change re-parses the
   * retained raw text. A new marker that points before the current end splits
   * the last segment from a checkpoint; if that raw text is gone, the marker is
   * treated as "now". Segment starts are fixed when their prompt arrives (the
   * running max of the markers at that time), so dropping an old, out-of-order
   * marker never moves later turns.
   */
  setMarkers(next: readonly number[]): void {
    if (sameNumbers(next, this.markers)) return;
    const previous = this.markers;
    let drop = -1;
    for (let candidate = 0; candidate <= previous.length; candidate++) {
      const keep = previous.length - candidate;
      if (keep > next.length) continue;
      let prefix = true;
      for (let index = 0; index < keep; index++) {
        if (!Object.is(previous[candidate + index], next[index])) {
          prefix = false;
          break;
        }
      }
      if (prefix) {
        drop = candidate;
        break;
      }
    }
    this.markers = [...next];
    if (drop < 0 || next.length === 0) {
      this.layout(this.rawStart, this.rawTail);
      return;
    }
    // Segment 0 is never displayed while prompts exist, so merging the dropped
    // segments into it only needs the remaining segments to shift down.
    if (drop > 0) this.segments.splice(0, Math.min(drop, this.segments.length - 1));
    for (const marker of next.slice(previous.length - drop)) this.addBoundary(marker);
  }

  view(prompts: readonly ChatPrompt[], title: string): ChatBlock[] {
    this.setMarkers(prompts.map((prompt) => prompt.marker));
    const parts: ChatBlock[][] = [];
    // Segment 0 is only shown when there are no prompts; its blocks sort first
    // so they could never displace later ones from the last-N window either.
    for (let index = prompts.length > 0 ? 1 : 0; index < this.segments.length; index++) {
      parts.push(this.segments[index].blocks(index, prompts[index - 1]?.text, title));
    }
    if (
      this.lastPrompts === prompts
      && this.lastTitle === title
      && parts.length === this.lastParts.length
      && parts.every((part, index) => part === this.lastParts[index])
    ) {
      return this.lastView;
    }
    const all = parts.length === 1 ? parts[0] : parts.flat();
    this.lastView = interleaveChatTurns(all.slice(-MAX_OUTPUT_BLOCKS), prompts).slice(-MAX_CHAT_BLOCKS);
    this.lastParts = parts;
    this.lastPrompts = prompts;
    this.lastTitle = title;
    return this.lastView;
  }

  private retain(raw: string): string {
    if (raw.length <= this.rawRetainChars + LINE_SLACK_CHARS) return raw;
    return this.rawRetainChars ? raw.slice(-this.rawRetainChars) : "";
  }

  private layout(from: number, text: string, markers: readonly number[] = this.markers): void {
    const hideFirst = markers.length > 0;
    this.segments = segmentStarts(markers, from)
      .map((start, index) => new TranscriptSegment(start, !(hideFirst && index === 0), this.limits));
    this.lastParts = [];
    this.route(text, from);
    this.pruneCheckpoints();
  }

  private segmentAt(pos: number): TranscriptSegment {
    let index = this.segments.length - 1;
    while (index > 0 && this.segments[index].start > pos) index--;
    return this.segments[index];
  }

  private route(text: string, at: number): void {
    const segments = this.segments;
    let index = segments.length - 1;
    while (index > 0 && segments[index].start > at) index--;
    let offset = 0;
    while (offset < text.length) {
      const nextStart = index + 1 < segments.length ? segments[index + 1].start : Infinity;
      const take = Math.min(text.length - offset, nextStart - (at + offset));
      if (take > 0) {
        segments[index].feed(offset === 0 && take === text.length ? text : text.slice(offset, offset + take), at + offset);
        offset += take;
      }
      if (offset < text.length) index++;
    }
  }

  private pruneCheckpoints(): void {
    const rawStart = this.rawStart;
    const lastIndex = this.segments.length - 1;
    this.segments.forEach((segment, index) => {
      if (index < lastIndex - 1) segment.checkpoints.length = 0;
      else segment.pruneCheckpoints(rawStart);
    });
  }

  private addBoundary(marker: number): void {
    const last = this.segments[this.segments.length - 1];
    let start = Math.max(Number.isFinite(marker) ? marker : this.end, last.start);
    if (start < this.end) {
      if (this.splitLastAt(start)) return;
      start = this.end;
    }
    this.segments.push(new TranscriptSegment(start, true, this.limits));
    this.pruneCheckpoints();
  }

  private splitLastAt(at: number): boolean {
    const rawStart = this.rawStart;
    if (at < rawStart) return false;
    const last = this.segments[this.segments.length - 1];
    if (last.enabled) {
      const checkpoint = last.checkpointBefore(at, rawStart);
      if (!checkpoint) return false;
      last.restore(checkpoint);
      if (at > checkpoint.pos) last.feed(this.rawTail.slice(checkpoint.pos - rawStart, at - rawStart), checkpoint.pos);
    } else {
      last.pos = at;
    }
    const next = new TranscriptSegment(at, true, this.limits);
    if (this.end > at) next.feed(this.rawTail.slice(at - rawStart), at);
    this.segments.push(next);
    this.pruneCheckpoints();
    return true;
  }
}
