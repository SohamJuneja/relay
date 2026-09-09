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
  /** Injectable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PollingHandle {
  /** Resolves once the token is proven and polling has been launched. Rejects only if the token is unusable. */
  readonly ready: Promise<void>;
  /** True from the moment polling is launched until `stop()` is called. */
  running(): boolean;
  /** How many times polling has been restarted after coming back unexpectedly. */
  restarts(): number;
  stop(): Promise<void>;
}

const isFatalAuth = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { error_code?: number }).error_code === 401;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function runPolling(bot: PollingBot, opts: PollingOptions): PollingHandle {
  const {
    log,
    dropPendingUpdates = false,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    healthyAfterMs = 60_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;

  let stopped = false;
  let launched = false;
  let restarts = 0;
  // Assigned synchronously by the Promise executor, which TypeScript cannot see.
  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const loop = (async () => {
    // One getMe. This is the only part of startup worth awaiting: it is the answer to
    // "is this token real", and it terminates.
    try {
      await bot.init();
    } catch (e) {
      rejectReady(e);
      log(`token check failed: ${message(e)}`);
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
          onStart: (me) => log(`listening as @${me.username}`),
          drop_pending_updates: dropPendingUpdates,
        });
        // A clean return means polling ended. That is expected only after stop().
        if (stopped) return;
        log("polling ended on its own — restarting");
      } catch (e) {
        if (stopped) return;
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
    async stop() {
      if (stopped) return;
      stopped = true;
      await bot.stop().catch((e) => log(`stop failed: ${message(e)}`));
      await loop.catch(() => undefined);
    },
  };
}
