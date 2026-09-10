// Supervising grammY's long polling.
//
// The trap this exists to avoid: `bot.start()` does not resolve when the bot is
// READY — it resolves when polling STOPS. Awaiting it as a startup step therefore
// never completes on a healthy bot, and any wrapper that puts a timeout or an abort
// around it reports a failure for a bot that is working perfectly.
//
// Worse, grammY rethrows out of the polling loop on 401 and 409 (see
// `handlePollingError`), so a single Conflict — which is exactly what happens while
// an old instance and a new one overlap during a deploy — rejects `start()` and
// leaves the process with no poller at all. Nothing inside grammY retries it.
//
// So: prove the token with `init()` (one getMe), report ready, then run `start()` as
// a long-running task that is restarted with backoff whenever it comes back, and is
// only allowed to finish for good when `stop()` is called.

/** The slice of grammY's `Bot` this supervisor needs — kept small so it can be stubbed. */
export interface PollingBot {
  init(): Promise<void>;
  /**
   * The raw getMe, used for the token check instead of init().
   *
   * `init()` memoises its promise — grammY does `this.mePromise ??= withRetries(...)`
   * — and withRetries retries internally with a backoff capped at an hour. So one
   * failure at boot caches a promise that may not settle for an hour, and every later
   * init() call awaits that SAME promise. A retry loop around init() therefore retries
   * nothing: it waits on one hung promise over and over. Observed in production as a
   * token check timing out every 20 s with restarts:0 forever, while a plain fetch of
   * the very same getMe answered 200 in 2.1 s from the same process.
   */
  api?: { getMe(): Promise<{ username: string }> } | undefined;
  start(options?: {
    onStart?: (me: { username: string }) => void | Promise<void>;
    drop_pending_updates?: boolean;
  }): Promise<void>;
  stop(): Promise<void>;
  readonly botInfo?: { username: string };
}

export interface PollingOptions {
  log: (...a: unknown[]) => void;
  /** Left false: pending updates are the user's messages, not ours to discard. */
  dropPendingUpdates?: boolean;
  /** First backoff step, doubling to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A run that lasted at least this long counts as healthy and resets the backoff. */
  healthyAfterMs?: number;
  /**
   * How long to give the token check before treating it as a failure.
   *
   * getMe has no timeout of its own, and a hosted environment that cannot reach
   * api.telegram.org does not refuse the connection — it hangs. That produced a bot
   * reporting enabled:true, running:false and lastError:null forever: never started,
   * never failed, nothing to see.
   */
  initTimeoutMs?: number;
  /** Injectable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PollingState {
  running: boolean;
  /** When the current run took the polling slot. */
  lastPollAt: number | null;
  lastError: string | null;
  restarts: number;
}

export interface PollingHandle {
  /** Resolves once the token is proven and polling has been launched. Rejects only if the token is unusable. */
  readonly ready: Promise<void>;
  /** True from the moment polling is launched until `stop()` is called. */
  running(): boolean;
  /** How many times polling has been restarted after coming back unexpectedly. */
  restarts(): number;
  /** Everything /health needs, in one read. */
  state(): PollingState;
  stop(): Promise<void>;
}

const isFatalAuth = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { error_code?: number }).error_code === 401;

/**
 * The message, plus whatever the thrown thing is wrapping.
 *
 * grammY's HttpError says only "Network request for 'getMe' failed!" and keeps the
 * real cause on `.error` — which is where the useful half lives: an ENOTFOUND, a
 * certificate problem, a 403 from something in the path. Reporting the wrapper alone
 * turns a specific failure into an unactionable one.
 */
const message = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const inner = (e as { error?: unknown; cause?: unknown }).error ?? (e as { cause?: unknown }).cause;
  if (!inner) return e.message;
  const innerMsg = inner instanceof Error ? `${inner.name}: ${inner.message}` : String(inner);
  const code = (inner as { cause?: { code?: string } })?.cause?.code ?? (inner as { code?: string })?.code;
  return `${e.message} — ${innerMsg}${code ? ` (${code})` : ""}`;
};

/** Reject after `ms` rather than waiting on a promise that may never settle. */
async function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error(why)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function runPolling(bot: PollingBot, opts: PollingOptions): PollingHandle {
  const {
    log,
    dropPendingUpdates = false,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    healthyAfterMs = 60_000,
    initTimeoutMs = 20_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;

  let stopped = false;
  let launched = false;
  let restarts = 0;
  let lastPollAt: number | null = null;
  let lastError: string | null = null;
  // Assigned synchronously by the Promise executor, which TypeScript cannot see.
  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const loop = (async () => {
    // One getMe — the answer to "is this token real". It is the only part of startup
    // worth awaiting, and the only part that can hang: grammY puts no timeout on it,
    // and a host that cannot reach api.telegram.org does not get refused, it waits.
    // Retried rather than fatal, because unreachable is usually temporary.
    let initDelay = baseDelayMs;
    for (let attempt = 1; !stopped; attempt++) {
      try {
        // bot.api.getMe() is NOT memoised, so each attempt is a real request.
        // init() is still called afterwards to populate botInfo, and by then the
        // answer is warm.
        if (bot.api) await withTimeout(bot.api.getMe(), initTimeoutMs, `token check did not answer within ${initTimeoutMs} ms`);
        await withTimeout(bot.init(), initTimeoutMs, `bot.init did not answer within ${initTimeoutMs} ms`);
        lastError = null;
        break;
      } catch (e) {
        lastError = message(e);
        if (isFatalAuth(e)) {
          rejectReady(e);
          log(`token check failed: ${message(e)} — the token is not valid`);
          return;
        }
        log(`token check failed (attempt ${attempt}): ${message(e)} — retrying in ${initDelay / 1000}s`);
        await sleep(initDelay);
        initDelay = Math.min(initDelay * 2, maxDelayMs);
      }
    }
    if (stopped) {
      resolveReady();
      return;
    }
    if (stopped) {
      resolveReady();
      return;
    }
    launched = true;
    log(`ready as @${bot.botInfo?.username ?? "unknown"} — starting long polling`);
    resolveReady();

    let delay = baseDelayMs;
    while (!stopped) {
      const startedAt = now();
      try {
        // Deliberately not awaited as a startup step — this is the whole run.
        await bot.start({
          onStart: (me) => {
            // The slot is ours from here — the one fact /health could not otherwise know.
            lastPollAt = now();
            lastError = null;
            log(`listening as @${me.username}`);
          },
          drop_pending_updates: dropPendingUpdates,
        });
        // A clean return means polling ended. That is expected only after stop().
        if (stopped) return;
        log("polling ended on its own — restarting");
      } catch (e) {
        if (stopped) return;
        lastError = message(e);
        if (isFatalAuth(e)) {
          log(`polling stopped: ${message(e)} — the token is not valid, not retrying`);
          return;
        }
        // 409 Conflict lands here, and it is usually transient: another instance of
        // this service is still shutting down and still holds getUpdates. Retrying is
        // the correct response, not giving up.
        log(`polling stopped: ${message(e)} — retrying`);
      }

      if (now() - startedAt >= healthyAfterMs) delay = baseDelayMs;
      restarts += 1;
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  })();

  // The loop owns every failure; nothing above should ever see an unhandled rejection.
  loop.catch((e) => log(`polling supervisor crashed: ${message(e)}`));
  ready.catch(() => undefined);

  return {
    ready,
    running: () => launched && !stopped,
    restarts: () => restarts,
    state: () => ({ running: launched && !stopped, lastPollAt, lastError, restarts }),
    async stop() {
      if (stopped) return;
      stopped = true;
      await bot.stop().catch((e) => log(`stop failed: ${message(e)}`));
      await loop.catch(() => undefined);
    },
  };
}
