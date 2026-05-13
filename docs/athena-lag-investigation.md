# Athena Lag Investigation

Date: 2026-05-13

## Symptom

The packaged Athena app became laggy while typing in embedded shells and while scrolling the UI.

## Findings

- The lag did not appear to be caused primarily by Hermes connecting from WSL.
- Multiple `ATHENA.exe` process groups were running at the same time during inspection:
  - one group started around 3:50 PM
  - another group started around 4:09 PM
- A 5-second CPU sample showed active ATHENA CPU load while WSL and Hermes-related processes were nearly idle.
- Native session discovery can add periodic work. A cold `listAgentSessionsCached("C:/Users/alanq/context-workspace")` call took roughly 379-492 ms, then cached calls returned in 0-1 ms until cache expiry.
- The app globally disables Electron GPU acceleration and compositing in `client/electron/main.ts`. That can make xterm rendering and scrolling CPU-bound in the real desktop app.
- The Review Room session inspector appends live terminal output into React state on every terminal data event. If a live terminal is selected, large buffers can cause frequent React re-renders.

## Likely Causes

1. Multiple Athena app instances are running, duplicating renderer work, polling, backend checks, native session discovery, and terminal rendering.
2. GPU acceleration is disabled for all desktop runs, not just CI/headless environments.
3. Review Room live buffer inspection can re-render a large `<pre>` on every terminal output chunk.
4. Native session refresh now does more work after Hermes and transcript support, so cold refreshes can cause periodic stutters.

## Recommended Fixes

1. Make GPU-disabling conditional for CI/headless runs only.
2. Throttle or batch Review Room live buffer updates and display only a bounded tail.
3. Cache Hermes WSL directory resolution longer than the session list cache.
4. Reduce native session refresh frequency or refresh only while Agents/Reviews are visible.
5. Add a lightweight performance diagnostic to show active app instance count, refresh timings, and session-discovery duration.

## Immediate Workaround

Close all running Athena instances and reopen one fresh instance before further testing. If lag disappears, duplicate processes were a major contributor.

