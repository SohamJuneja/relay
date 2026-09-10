// A Cloudflare Worker that forwards the Telegram Bot API, and nothing else.
//
// Render's egress to api.telegram.org times out — measured, not assumed:
//
//   order=ipv4first · A=[149.154.166.110] · AAAA=[2001:67c:4e8:f004::9]
//   TypeError: ETIMEDOUT after 2100 ms
//
// DNS resolves both families, the same instance reaches Neon and the Somnia RPC
// continuously, and the same request from a laptop answers HTTP 200 in 1.3 s. So the
// route to Telegram specifically is blocked, and no amount of retrying fixes it.
//
// This is a proxy rather than a webhook receiver on purpose. A webhook solves only
// half the problem — Telegram reaching us — and leaves every reply, which is an
// outbound sendMessage, hitting the same wall. Pointing grammY's `apiRoot` here fixes
// both directions at once and leaves long polling and every handler untouched.
//
// SECURITY. The Bot API puts the token in the path, so this Worker sees it on every
// request. It therefore:
//
//   · forwards only /bot<TOKEN>/… for the ONE token it is configured with, so it
//     cannot be used as a general-purpose Telegram relay by anyone who finds the URL;
//   · never logs the path, the query or the body — all three can carry the token or a
//     user's message. A Worker's logs are not the place for either;
//   · compares the token in constant time. Not because a timing oracle across the
//     public internet is a practical attack, but because the alternative is writing
//     code that looks like it was not thought about.
//
// The proxy adds no exposure the token does not already carry: anyone holding it can
// call api.telegram.org directly. What the check prevents is the URL becoming a free
// relay for someone else's bot.

export interface Env {
  /** The bot token this proxy serves. Set with `wrangler secret put BOT_TOKEN`. */
  BOT_TOKEN: string;
}

const UPSTREAM = "https://api.telegram.org";

/** Constant-time string comparison. Returns false for different lengths. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.BOT_TOKEN) {
      // Configuration, not a request problem — and still no detail in the body.
      return new Response("proxy is not configured\n", { status: 503 });
    }

    const url = new URL(request.url);

    // /bot<token>/method  →  ["", "bot<token>", "method", …]
    const segments = url.pathname.split("/");
    const botSegment = segments[1] ?? "";
    const expected = `bot${env.BOT_TOKEN}`;

    // A file download uses /file/bot<token>/… — allowed, because a photo card will
    // need it and it is the same credential and the same upstream.
    const isFile = botSegment === "file";
    const tokenSegment = isFile ? (segments[2] ?? "") : botSegment;
    if (!timingSafeEqual(tokenSegment, expected) || (isFile ? segments.length < 4 : segments.length < 3)) {
      return new Response("forbidden\n", { status: 403 });
    }

    // Method, headers and body pass through untouched. `request.body` is a stream, so
    // a multipart upload is forwarded without being buffered — which is what makes
    // sendPhoto work without this Worker holding the file in memory.
    const headers = new Headers(request.headers);
    // Host must be the upstream's; CF's own hop headers mean nothing there.
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("x-forwarded-proto");
    headers.delete("x-real-ip");

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
      const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
      });

      // Pass the response through as-is: grammY reads Telegram's own status codes and
      // JSON error bodies (429 with retry_after, 409 Conflict), and rewriting any of
      // that would break the retry logic that depends on it.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (e) {
      // The error's message only, and never the URL it was fetching.
      return new Response(`upstream unreachable: ${(e as Error).message}\n`, { status: 502 });
    }
  },
};
