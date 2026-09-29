// Permanent incident coverage: async-but-main-thread scans (#95),
// multi-workspace amplification (#154), OOM bounds (#169), and global Hermes
// deduplication (#170). The imported suites assert incremental parsing,
// metadata-only persistence, workspace-before-limit, and last-known-good data;
// that native provider scans run in the long-lived index child with per-file
// (mtime, size) caches and workspace-scoped Claude folders; and that sqlite
// reads never spawn the Windows Store Python stub per query.
import "../hermes-session-index.test.mjs";
import "../agent-sessions.test.mjs";
import "../sqlite.test.mjs";
