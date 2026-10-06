// Permanent coverage for remote session history and resume (#220). Keep remote
// discovery bounded and independent of terminal traffic; preserve authorization,
// worker failure isolation, snapshot paging and resume routing.
import "../remote-session-history.test.mjs";
import "../remote-session-route.test.mjs";
import "../remote-client.test.mjs";
