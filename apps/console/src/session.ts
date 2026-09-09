// The partner's API key, for the length of one tab.
//
// sessionStorage, never localStorage: this is a bearer credential that reads a
// partner's revenue data, and the register page shows it exactly once. Keeping it
// past the tab is a decision for the partner's own password manager, not for us.

const KEY = "relay.console.key";
const ID = "relay.console.partner";

export interface Session {
  partnerId: number;
  apiKey: string;
}

export function loadSession(): Session | null {
  try {
    const apiKey = sessionStorage.getItem(KEY);
    const partnerId = Number(sessionStorage.getItem(ID));
    if (!apiKey || !Number.isInteger(partnerId) || partnerId <= 0) return null;
    return { partnerId, apiKey };
  } catch {
    return null; // storage blocked (private mode, sandboxed frame)
  }
}

export function saveSession(s: Session): void {
  try {
    sessionStorage.setItem(KEY, s.apiKey);
    sessionStorage.setItem(ID, String(s.partnerId));
  } catch {
    /* not persistable — the page still works for this view */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(ID);
  } catch {
    /* ignore */
  }
}
