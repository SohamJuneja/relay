// Resolve IPv4 before IPv6, process-wide.
//
// Node 18 changed the default from `ipv4first` to `verbatim`, which means a hostname
// with both A and AAAA records is tried in the order DNS returns them — usually AAAA
// first. api.telegram.org has both.
//
// On a host with no IPv6 route, that connection does not get refused. There is nowhere
// to send a rejection *from*, so the SYN goes out and nothing comes back, and the
// socket sits there until something times it out. Node's fetch has no default timeout,
// and neither does grammY's getMe — so the bot waited, silently, forever. On /health
// that looked like: enabled true, running false, lastError null, restarts 0. Never
// started, never failed, nothing in the logs.
//
// This must run before the first DNS lookup, and it is a module rather than a line at
// the top of an entry point because ESM evaluates all imports before any statement in
// the importing module. Imported first, it is evaluated first.

import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

/** Whether the preference has been applied — for diagnostics that want to say so. */
export const IPV4_FIRST = true;
