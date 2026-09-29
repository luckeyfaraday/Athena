// Permanent incident coverage: accelerated rendering fixed software-paint CPU
// (#26), global Linux acceleration later exposed native crashes (#100), and
// renderer mitigations could not resolve that policy conflict (#184). A later
// incident left Windows permanently in software compositing after one unclean
// exit, so quarantine is now Linux-only, GPU-crash-driven, and expiring.
import "../graphics-state.test.mjs";
