import assert from "node:assert/strict";
import test from "node:test";

import {
  TERMINAL_ATTENTION_TIMINGS,
  TerminalAttentionTracker,
  createTerminalScanState,
  isTerminalReportInput,
  matchAttentionPrompt,
  scanTerminalOutput,
} from "../dist-electron/terminal-attention.js";

const { promptConfirmMs, scanThrottleMs, turnSettleMs } = TERMINAL_ATTENTION_TIMINGS;
// Worst case from a prompt being drawn to its report: a throttled scan, then the stillness check.
const promptLatencyMs = scanThrottleMs + promptConfirmMs + 50;

function scan(...chunks) {
  const state = createTerminalScanState();
  const results = chunks.map((chunk) => scanTerminalOutput(state, chunk));
  return {
    text: results.map((result) => result.text).join(""),
    printable: results.some((result) => result.printable),
    bells: results.reduce((sum, result) => sum + result.bells, 0),
    notifications: results.flatMap((result) => result.notifications),
  };
}

test("ConPTY cursor-forward cells read as spaces, so prompts drawn as screen diffs still match", () => {
  const { text } = scan("\x1b[14;2H❯\x1b[1CDo\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?\x1b[15;4H1.\x1b[1CYes");
  assert.match(text, /Do you want to proceed\?/);
  assert.deepEqual(matchAttentionPrompt(text.replace(/\s+/g, " ")), { reason: "approval", message: "Waiting for your approval" });
});

test("only a bare BEL rings; BEL ending an OSC title (even split across chunks) does not", () => {
  assert.equal(scan("\x1b]0;claude\x07").bells, 0);
  assert.equal(scan("\x1b]0;cla", "ude\x07done").bells, 0);
  assert.equal(scan("\x1b]2;title\x1b\\").bells, 0);
  assert.equal(scan("build finished\x07").bells, 1);
});

test("desktop notifications come from OSC 9, 777 and 99, but not from progress, cwd or capability queries", () => {
  assert.deepEqual(scan("\x1b]9;Claude needs your permission to use Bash\x07").notifications, ["Claude needs your permission to use Bash"]);
  assert.deepEqual(scan("\x1b]777;notify;Claude Code;Task finished\x1b\\").notifications, ["Task finished"]);
  assert.deepEqual(scan("\x1b]9;4;3;\x07", "\x1b]9;4;0;\x07").notifications, [], "OSC 9;4 is a progress bar");
  assert.deepEqual(scan("\x1b]9;9;C:\\work\x07").notifications, [], "OSC 9;9 reports the working directory");
  assert.deepEqual(scan("\x1b]99;i=opentui-notifications:p=?;\x1b\\").notifications, [], "OpenCode's capability query");
  assert.deepEqual(
    scan("\x1b]99;i=7:d=0:p=title;Claude Code\x1b\\", "\x1b]99;i=7:p=body;Waiting for input\x1b\\", "\x1b]99;i=7:d=1:a=focus;\x1b\\").notifications,
    ["Waiting for input"],
    "kitty shows the final chunk once",
  );
  assert.deepEqual(scan("\x1b]9;split across", " chunks\x07").notifications, ["split across chunks"]);
});

test("frames with no visible characters (sync markers, blanks, cursor moves) are not activity", () => {
  assert.equal(scan("\x1b[?2026h", "\x1b[?2026l").printable, false);
  assert.equal(scan("\x1b[12;3H   \x1b[K").printable, false);
  assert.equal(scan("\x1b[12;3H●").printable, true);
});

test("agent prompts are recognized as the CLIs print them", () => {
  const cases = [
    ["Bash command mkdir probe-dir Do you want to proceed? ❯ 1. Yes 2. Yes, and always allow access 3. No", "approval"],
    ["Do you want to make this edit to App.tsx?", "approval"],
    ["3. No, and tell Claude what to do differently (esc)", "approval"],
    ["Would you like to run the following command? Reason: Allow creating probe-dir", "approval"],
    ["Would you like to make the following edits?", "approval"],
    ["△ Permission required ← Access external directory", "approval"],
    ["Allow once Allow always Reject", "approval"],
    ["⚠️ Dangerous Command rm -rf build", "approval"],
    ["Yes, and don't ask again for bash commands", "approval"],
    ["Ready to code? Would you like to proceed? No, keep planning", "approval"],
    ["Which approach? 1. Fast 2. Safe 3. Chat about this Enter to select · ↑/↓ to navigate · Esc to cancel", "question"],
    ["❯ No, exit Yes, I trust this folder Enter to confirm · Esc to cancel", "trust"],
    ["Trust this folder? Codex can read, edit, and run files here", "trust"],
    ["Overwrite existing config? [y/N] ", "yes-no"],
  ];
  for (const [text, reason] of cases) assert.equal(matchAttentionPrompt(text)?.reason, reason, text);
});

test("ordinary output that the old keyword scan alerted on is not a prompt", () => {
  for (const text of [
    "vite v7.0.0 building for production... ✓ built in 2.31s, done",
    "All 42 tests passed",
    "Task complete. Ready for review.",
    "✻ Baked for 6s · done 21:25",
    "Press Ctrl-C again to exit",
    "Select a model",
    "• Starting MCP servers (0/3): blender (0s • esc to interrupt)",
    "git@github.com: Permission denied (publickey).",
    "This package requires Node 18; continue reading the docs",
    "waiting for the dev server to start",
    "Scripts can ask [y/N] questions; ours never do.",
  ]) {
    assert.equal(matchAttentionPrompt(text), null, text);
  }
});

test("terminal-generated reports are not the user typing", () => {
  for (const data of [
    "\x1b[I", "\x1b[O", "\x1b[I\x1b[O", "\x1b[12;40R", "\x1b[?62;22c", "\x1b[>0;276;0c", "\x1b[0n",
    "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1bP>|xterm.js(6.0.0)\x1b\\",
    "\x1b[<64;10;5M", "\x1b[<65;10;5M", "\x1b[<35;10;5M", "\x1b[<0;10;5m", "\x1b[?0u",
  ]) {
    assert.equal(isTerminalReportInput(data), true, JSON.stringify(data));
  }
  for (const data of ["y", "\r", "\x1b[B", "\x03", "\x1b", "fix the bug\r", "\x1b[<0;10;5M", "\x1b[Iy", ""]) {
    assert.equal(isTerminalReportInput(data), false, JSON.stringify(data));
  }
});

function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, dueAt: now + delayMs });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle),
    pendingTimers: () => timers.size,
    // Fire due timers in deadline order, each at its own due time.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [handle, timer] of timers) {
          if (timer.dueAt <= target && (!next || timer.dueAt < next[1].dueAt)) next = [handle, timer];
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
      }
      now = target;
    },
  };
}

function trackerFor({ agent = true, armed = false } = {}) {
  const clock = fakeClock();
  const reports = [];
  const tracker = new TerminalAttentionTracker(
    (event) => reports.push({ ...event, at: clock.now() }),
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  tracker.register("t", { agent, armed });
  return { clock, reports, tracker };
}

// A working agent: a spinner redrawing every 100 ms for `ms`.
function work(clock, tracker, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    clock.advance(100);
    tracker.observe("t", `\x1b[20;2H${"✻✶*✢·"[(elapsed / 100) % 5]} Working… (${Math.floor(elapsed / 1000)}s · esc to interrupt)`);
  }
}

const CLAUDE_PROMPT = "\x1b[8;2HBash\x1b[1Ccommand\x1b[10;2HDo\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?\x1b[11;2H❯ 1. Yes\x1b[13;2H3.\x1b[1CNo,\x1b[1Cand\x1b[1Ctell\x1b[1CClaude\x1b[1Cwhat\x1b[1Cto\x1b[1Cdo\x1b[1Cdifferently";

test("an approval prompt alerts once the agent holds still, and once only until the user answers", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "clean the build folder\r");
  work(clock, tracker, 2_000);
  tracker.observe("t", CLAUDE_PROMPT);
  // Claude Code blinks the pending tool's dot while it waits.
  for (let blink = 0; blink < 10; blink += 1) {
    clock.advance(600);
    tracker.observe("t", blink % 2 ? "\x1b[8;1H " : "\x1b[8;1H●");
  }
  assert.deepEqual(reports.map(({ kind, reason }) => ({ kind, reason })), [{ kind: "action", reason: "approval" }]);
  assert.ok(reports[0].at <= 2_000 + promptLatencyMs, "reported soon after the prompt appeared");

  tracker.observe("t", CLAUDE_PROMPT); // a resize redraws the same prompt
  clock.advance(promptConfirmMs + turnSettleMs);
  assert.equal(reports.length, 1, "redraws of an unanswered prompt stay quiet");

  tracker.noteInput("t", "\r");
  work(clock, tracker, 1_500);
  tracker.observe("t", CLAUDE_PROMPT);
  clock.advance(promptLatencyMs);
  assert.deepEqual(reports.map((report) => report.reason), ["approval", "approval"], "the next prompt alerts again");
});

test("prompt words inside output that keeps streaming (a diff, a file) do not alert", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "\r");
  work(clock, tracker, 1_000);
  tracker.observe("t", "\x1b[5;1H+ { pattern: /\\ballow once\\b/i, reason: \"approval\" },\r\n+ Do you want to proceed?");
  work(clock, tracker, 2_500);
  clock.advance(100);
  assert.equal(reports.filter((report) => report.kind === "action").length, 0);
});

test("a finished turn alerts once output stops after sustained work", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "fix the failing test\r");
  clock.advance(20);
  tracker.observe("t", "fix the failing test"); // echo
  work(clock, tracker, 5_000);
  const lastOutputAt = clock.now();
  clock.advance(turnSettleMs + 500);
  assert.deepEqual(reports, [{ id: "t", kind: "update", reason: "turn-complete", message: null, at: lastOutputAt + turnSettleMs }]);

  work(clock, tracker, 2_500); // later redraws without new input
  clock.advance(turnSettleMs + 500);
  assert.equal(reports.length, 1, "one report per turn");
});

test("typing is echo, not a turn", () => {
  const { clock, reports, tracker } = trackerFor();
  for (const character of "please refactor the settings room layout") {
    tracker.noteInput("t", character);
    clock.advance(30);
    tracker.observe("t", character);
    clock.advance(120);
  }
  clock.advance(turnSettleMs * 2);
  assert.equal(reports.length, 0);
});

test("a short burst is not a turn, and the terminal stays armed for the real one", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "\r");
  clock.advance(500);
  work(clock, tracker, 1_000);
  clock.advance(turnSettleMs + 500);
  assert.equal(reports.length, 0);
  work(clock, tracker, 4_000);
  clock.advance(turnSettleMs + 500);
  assert.deepEqual(reports.map((report) => report.reason), ["turn-complete"]);
});

test("output nobody asked for (startup, restore) is not a finished turn, unless the agent was launched with a task", () => {
  const idle = trackerFor();
  work(idle.clock, idle.tracker, 4_000);
  idle.clock.advance(turnSettleMs + 500);
  assert.equal(idle.reports.length, 0);

  const tasked = trackerFor({ armed: true });
  work(tasked.clock, tasked.tracker, 4_000);
  tasked.clock.advance(turnSettleMs + 500);
  assert.deepEqual(tasked.reports.map((report) => report.reason), ["turn-complete"]);
});

test("an agent stopped at a prompt reports the prompt, not a finished turn; answering it restarts the turn", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "create probe-dir\r");
  work(clock, tracker, 3_000);
  // Codex goes completely still (empty sync frames) at its approval prompt.
  tracker.observe("t", "\x1b[?2026h\x1b[12;2HWould you like to run the following command?\x1b[14;2H› 1. Yes, proceed (y)\x1b[?2026l");
  for (let frame = 0; frame < 20; frame += 1) {
    clock.advance(500);
    tracker.observe("t", "\x1b[?2026h\x1b[?2026l");
  }
  assert.deepEqual(reports.map((report) => report.reason), ["approval"]);

  tracker.noteInput("t", "y");
  work(clock, tracker, 3_000);
  clock.advance(turnSettleMs + 500);
  assert.deepEqual(reports.map((report) => report.reason), ["approval", "turn-complete"]);
});

test("focus changes and query replies do not count as answering a prompt", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.observe("t", CLAUDE_PROMPT);
  clock.advance(promptLatencyMs);
  assert.equal(reports.length, 1);
  tracker.noteInput("t", "\x1b[I");
  tracker.noteInput("t", "\x1b[<65;10;5M");
  tracker.observe("t", CLAUDE_PROMPT);
  clock.advance(promptLatencyMs);
  assert.equal(reports.length, 1);
});

test("a keystroke while a prompt is being confirmed means the user is already there", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.observe("t", "❯ No, exit Yes, I trust this folder Enter to confirm · Esc to cancel");
  clock.advance(700);
  tracker.noteInput("t", "\x1b[B");
  clock.advance(promptConfirmMs * 2);
  assert.equal(reports.length, 0);
});

test("shells report y/n prompts and bells, but never guess at finished commands", () => {
  const { clock, reports, tracker } = trackerFor({ agent: false });
  tracker.noteInput("t", "npm run build\r");
  work(clock, tracker, 6_000);
  clock.advance(turnSettleMs + 500);
  assert.equal(reports.length, 0, "no turn tracking in shells");

  tracker.observe("t", "\r\nOverwrite dist/index.html? [y/N] ");
  clock.advance(promptLatencyMs);
  assert.deepEqual(reports.map(({ kind, reason }) => ({ kind, reason })), [{ kind: "action", reason: "yes-no" }]);

  tracker.noteInput("t", "\t");
  tracker.observe("t", "\x07"); // failed tab completion
  assert.equal(reports.length, 1, "a bell right after a keystroke is feedback");
  clock.advance(5_000);
  tracker.observe("t", "\x07");
  assert.deepEqual(reports.at(-1), { id: "t", kind: "update", reason: "bell", message: null, at: clock.now() });
});

test("explicit notifications report immediately and do not double up with a detected prompt", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "\r");
  tracker.observe("t", CLAUDE_PROMPT);
  clock.advance(300);
  tracker.observe("t", "\x1b]9;Claude needs your permission to use Bash\x07");
  assert.deepEqual(reports.map(({ kind, reason, message }) => ({ kind, reason, message })), [
    { kind: "action", reason: "notification", message: "Claude needs your permission to use Bash" },
  ]);
  clock.advance(promptConfirmMs * 2);
  assert.equal(reports.length, 1);
});

test("prompts split across output batches and scan throttling are still caught", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.observe("t", "\x1b[12;2HWould you like to run the fol");
  clock.advance(10);
  tracker.observe("t", "lowing command?");
  clock.advance(promptLatencyMs);
  assert.deepEqual(reports.map((report) => report.reason), ["approval"]);
});

test("exits report once with the exit code, and clearing a terminal cancels its timers", () => {
  const { clock, reports, tracker } = trackerFor();
  tracker.noteInput("t", "\r");
  work(clock, tracker, 1_000);
  tracker.observe("t", CLAUDE_PROMPT);
  tracker.noteExit("t", 2);
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(turnSettleMs * 2);
  assert.deepEqual(reports, [{ id: "t", kind: "update", reason: "exit", message: "Exited with code 2", at: clock.now() - turnSettleMs * 2 }]);

  const other = trackerFor();
  other.tracker.noteInput("t", "\r");
  work(other.clock, other.tracker, 1_000);
  other.tracker.clear("t");
  assert.equal(other.clock.pendingTimers(), 0);
});
