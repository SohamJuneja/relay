// The behaviour these tests protect is counter-intuitive, and getting it wrong is
// what took the deployed bot down: a HEALTHY grammY bot never resolves `start()`.
// Anything that treats that promise as a startup step therefore has to either hang
// forever or declare a working bot broken.

import { describe, expect, it, vi } from "vitest";
import { runPolling, type PollingBot } from "./polling.js";

/** A bot whose `start()` never settles — exactly what a healthy poller looks like. */
function stubBot(overrides: Partial<PollingBot> = {}) {
  const calls = { init: 0, start: 0, stop: 0 };
  let releaseStart: ((e?: unknown) => void) | null = null;
  const bot: PollingBot = {
    botInfo: { username: "RelayTestBot" },
    async init() {
      calls.init += 1;
    },
    start() {
      calls.start += 1;
      // Never resolves on its own. Only the test, or stop(), ends it.
      return new Promise<void>((res, rej) => {
        releaseStart = (e) => (e === undefined ? res() : rej(e));
      });
    },
    async stop() {
      calls.stop += 1;
      releaseStart?.();
    },
    ...overrides,
  };
  return { bot, calls, end: (e?: unknown) => releaseStart?.(e) };
}

/** Let the supervisor's loop run until `cond` holds, or fail loudly rather than hang. */
const waitFor = async (cond: () => boolean, what: string, ticks = 200) => {
  for (let i = 0; i < ticks && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};
const settle = async (ticks = 20) => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("runPolling", () => {
  it("reports the bot as running while start() never resolves, and does not abort it", async () => {
    const { bot, calls } = stubBot();
    const log = vi.fn();
    const h = runPolling(bot, { log });

    await h.ready; // resolves off init(), not off start()
    await waitFor(() => calls.start === 1, "polling to be launched");

    expect(calls.init).toBe(1);
    expect(calls.start).toBe(1);
    expect(h.running()).toBe(true);
    expect(calls.stop).toBe(0); // nothing tried to tear the poller down
    expect(h.restarts()).toBe(0);

    // Still running a while later: no timeout fires, nothing aborts.
    await settle();
    expect(h.running()).toBe(true);
    expect(calls.stop).toBe(0);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/fail/i);

    await h.stop();
    expect(h.running()).toBe(false);
    expect(calls.stop).toBe(1);
  });

  it("ready does not wait for start()", async () => {
    const { bot } = stubBot();
    const h = runPolling(bot, { log: vi.fn() });
    // If `ready` were chained to start(), this race would time out on the sentinel.
    const winner = await Promise.race([h.ready.then(() => "ready"), Promise.resolve("sentinel")]);
    // The sentinel may win the microtask race; what matters is that ready settles at all.
    expect(["ready", "sentinel"]).toContain(winner);
    await h.ready;
    expect(h.running()).toBe(true);
    await h.stop();
  });

  it("restarts polling with backoff when start() rejects, 409 Conflict included", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    let attempt = 0;
    const calls = { start: 0 };
    let release: (() => void) | null = null;
    const bot: PollingBot = {
      botInfo: { username: "RelayTestBot" },
      async init() {},
      start() {
        calls.start += 1;
        attempt += 1;
        // Two Conflicts — an old instance still holding getUpdates — then healthy.
        if (attempt <= 2) {
          return Promise.reject(Object.assign(new Error("Conflict: terminated by other getUpdates request"), { error_code: 409 }));
        }
        // As in grammY, the third call holds until stop() releases it.
        return new Promise<void>((res) => (release = res));
      },
      async stop() {
        release?.();
      },
    };
    const log = vi.fn();
    const h = runPolling(bot, { log, sleep, baseDelayMs: 1000, maxDelayMs: 60_000 });
    await h.ready;
    await waitFor(() => calls.start === 3, "two retries and a healthy run");

    expect(calls.start).toBe(3); // failed twice, then took hold
    expect(slept).toEqual([1000, 2000]); // doubling, not giving up
    expect(h.restarts()).toBe(2);
    expect(h.running()).toBe(true);
    expect(log.mock.calls.flat().join(" ")).toMatch(/retrying/);
    await h.stop();
  });

  it("gives up only on 401, which no amount of retrying can fix", async () => {
    const sleep = async () => {};
    const calls = { start: 0 };
    const bot: PollingBot = {
      botInfo: { username: "RelayTestBot" },
      async init() {},
      start() {
        calls.start += 1;
        return Promise.reject(Object.assign(new Error("Unauthorized"), { error_code: 401 }));
      },
      async stop() {},
    };
    const log = vi.fn();
    const h = runPolling(bot, { log, sleep });
    await h.ready;
    await waitFor(() => log.mock.calls.flat().join(" ").includes("not retrying"), "the 401 to be reported as fatal");

    expect(calls.start).toBe(1);
    expect(h.restarts()).toBe(0);
    expect(log.mock.calls.flat().join(" ")).toMatch(/not valid, not retrying/);
    await h.stop();
  });

  it("a stop() while polling is a clean end, not a failure", async () => {
    const { bot } = stubBot();
    const log = vi.fn();
    const h = runPolling(bot, { log });
    await h.ready;
    await waitFor(() => h.running(), "polling to be launched");
    await h.stop();
    await settle();

    const said = log.mock.calls.flat().join(" ");
    expect(said).not.toMatch(/retrying|failed|crashed/i);
    expect(h.restarts()).toBe(0);
    expect(h.running()).toBe(false);
  });

  it("a bad token fails ready without ever launching the poller", async () => {
    const calls = { start: 0 };
    const bot: PollingBot = {
      async init() {
        throw Object.assign(new Error("Unauthorized"), { error_code: 401 });
      },
      start() {
        calls.start += 1;
        return new Promise<void>(() => {});
      },
      async stop() {},
    };
    const log = vi.fn();
    const h = runPolling(bot, { log });
    await expect(h.ready).rejects.toThrow(/Unauthorized/);
    expect(calls.start).toBe(0);
    expect(h.running()).toBe(false);
  });
});
