import { describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "../../src/http/types.js";
import type { AdvisoryLock } from "../../src/scheduler/advisoryLock.js";
import {
  createNodeScheduler,
  withAdvisoryLock,
  type CronScheduler,
} from "../../src/scheduler/nodeScheduler.js";

const jobs = [
  { jobId: "nightly-report", schedule: "15 2 * * *", path: "/api/cron/nightly-report" },
  { jobId: "queue-drain", schedule: "*/3 * * * *", path: "/api/cron/queue-drain" },
];

function timers() {
  const callbacks: Array<() => void | Promise<void>> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const schedule = vi.fn<CronScheduler["schedule"]>((_expression, handler) => {
    callbacks.push(handler);
    const stop = vi.fn();
    stops.push(stop);
    return { stop };
  });
  return { cron: { schedule }, callbacks, stops };
}

function mutex(granted = true) {
  return {
    tryAcquire: vi.fn<AdvisoryLock["tryAcquire"]>().mockResolvedValue(granted),
    release: vi.fn<AdvisoryLock["release"]>().mockResolvedValue(undefined),
    close: vi.fn<AdvisoryLock["close"]>().mockResolvedValue(undefined),
  };
}

describe("advisory guarded execution", () => {
  it("acquires before running and releases after completion", async () => {
    const events: string[] = [];
    const lock = mutex();
    lock.tryAcquire.mockImplementation(async (id) => { events.push(`acquire:${id}`); return true; });
    lock.release.mockImplementation(async (id) => { events.push(`release:${id}`); });
    const onError = vi.fn();
    await withAdvisoryLock("queue-drain", lock, () => { events.push("body"); }, onError)();
    expect(events).toEqual(["acquire:queue-drain", "body", "release:queue-drain"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("silently skips without releasing a lock held elsewhere", async () => {
    const lock = mutex(false);
    const body = vi.fn();
    const onError = vi.fn();
    await withAdvisoryLock("queue-drain", lock, body, onError)();
    expect(lock.tryAcquire).toHaveBeenCalledWith("queue-drain");
    expect(body).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("reports a body %s and releases in finally", async (mode) => {
    const lock = mutex();
    const failure = new Error("job failed");
    const onError = vi.fn();
    const body = () => { if (mode === "throw") throw failure; return Promise.reject(failure); };
    await expect(withAdvisoryLock("nightly-report", lock, body, onError)()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith("nightly-report", failure);
    expect(lock.release).toHaveBeenCalledExactlyOnceWith("nightly-report");
  });

  it("releases even when the error sink throws", async () => {
    const lock = mutex();
    const failure = new Error("sink failed");
    await expect(withAdvisoryLock("queue-drain", lock, () => { throw new Error("body failed"); },
      () => { throw failure; })()).rejects.toBe(failure);
    expect(lock.release).toHaveBeenCalledWith("queue-drain");
  });
});

describe("Node scheduler", () => {
  it("exposes the supplied registry and prefers a trimmed explicit schedule", () => {
    const { cron } = timers();
    const adapter = createNodeScheduler({ cron, jobs, env: {}, timezone: "UTC" });
    expect(adapter.jobs).toBe(jobs);
    adapter.register({ jobId: "nightly-report", schedule: "  0 9 * * *  ", handler: vi.fn() });
    expect(cron.schedule).toHaveBeenCalledExactlyOnceWith("0 9 * * *", expect.any(Function), { timezone: "UTC" });
  });

  it.each([undefined, "", "   "])("uses the registry for schedule %s", (schedule) => {
    const { cron } = timers();
    const adapter = createNodeScheduler({ cron, jobs, env: {} });
    adapter.register({ jobId: "queue-drain", schedule, handler: vi.fn() } as Parameters<typeof adapter.register>[0]);
    expect(cron.schedule).toHaveBeenCalledWith("*/3 * * * *", expect.any(Function), { timezone: undefined });
  });

  it("refuses an unknown job without a schedule before creating a timer", () => {
    const { cron } = timers();
    const adapter = createNodeScheduler({ cron, jobs, env: {} });
    expect(() => adapter.register({ jobId: "unknown-task", schedule: "", handler: vi.fn() }))
      .toThrow('node-scheduler: job "unknown-task" is not declared in config/platform-runtime.json crons');
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it("accepts an explicit schedule for a job outside the registry", () => {
    const { cron } = timers();
    createNodeScheduler({ cron, jobs, env: {} }).register({
      jobId: "extra-task", schedule: "0 8 * * *", handler: vi.fn(),
    });
    expect(cron.schedule).toHaveBeenCalledWith("0 8 * * *", expect.any(Function), { timezone: undefined });
  });

  it("guards the timer body and sends failures to the configured sink", async () => {
    const { cron, callbacks } = timers();
    const lock = mutex();
    const onError = vi.fn();
    const failure = new Error("timer failed");
    const body = vi.fn().mockRejectedValue(failure);
    createNodeScheduler({ cron, jobs, lock, onError, env: {} }).register({
      jobId: "nightly-report", schedule: "", handler: body,
    });
    await callbacks[0]();
    expect(lock.tryAcquire).toHaveBeenCalledWith("nightly-report");
    expect(body).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("nightly-report", failure);
    expect(lock.release).toHaveBeenCalledWith("nightly-report");
  });

  it("stops every timer once and supports later registrations", async () => {
    const { cron, stops } = timers();
    const adapter = createNodeScheduler({ cron, jobs, env: {} });
    for (const job of jobs) adapter.register({ ...job, handler: vi.fn() });
    await adapter.stopAll();
    await adapter.stopAll();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    adapter.register({ ...jobs[0], handler: vi.fn() });
    await adapter.stopAll();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it("fences callbacks from stopped registrations while later registrations remain runnable", async () => {
    const { cron, callbacks } = timers();
    const lock = mutex();
    const body = vi.fn();
    const adapter = createNodeScheduler({ cron, jobs, lock, env: {} });
    adapter.register({ ...jobs[0], handler: body });

    const stopping = adapter.stopAll();
    await callbacks[0]();
    expect(body).not.toHaveBeenCalled();
    expect(lock.tryAcquire).not.toHaveBeenCalled();
    await stopping;

    adapter.register({ ...jobs[0], handler: body });
    await callbacks[1]();
    expect(body).toHaveBeenCalledTimes(1);
    await adapter.stopAll();
  });

  it("waits for an admitted callback and its lock release before completing stopAll", async () => {
    const { cron, callbacks, stops } = timers();
    const lock = mutex();
    let enter!: () => void;
    let finish!: () => void;
    let releasing!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const releaseStarted = new Promise<void>((resolve) => { releasing = resolve; });
    const releasePending = new Promise<void>((resolve) => { release = resolve; });
    lock.release.mockImplementation(async () => { releasing(); await releasePending; });
    const adapter = createNodeScheduler({ cron, jobs, lock, env: {} });
    adapter.register({ ...jobs[0], handler: async () => { enter(); await pending; } });
    const running = callbacks[0]();
    await entered;
    let stopped = false;
    const stopping = Promise.resolve(adapter.stopAll()).then(() => { stopped = true; });
    try {
      expect(stops[0]).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish();
      await releaseStarted;
      expect(stopped).toBe(false);
      release();
      await Promise.all([running, stopping]);
      expect(stopped).toBe(true);
    } finally {
      finish();
      release();
      await Promise.allSettled([running, stopping]);
    }
  });

  it("drains a callback admitted before its lock acquisition resolves", async () => {
    const { cron, callbacks } = timers();
    const lock = mutex();
    let acquiring!: () => void;
    let grant!: (value: boolean) => void;
    const started = new Promise<void>((resolve) => { acquiring = resolve; });
    const acquisition = new Promise<boolean>((resolve) => { grant = resolve; });
    lock.tryAcquire.mockImplementation(() => { acquiring(); return acquisition; });
    const body = vi.fn();
    const adapter = createNodeScheduler({ cron, jobs, lock, env: {} });
    adapter.register({ ...jobs[0], handler: body });
    const running = callbacks[0]();
    await started;
    let stopped = false;
    const stopping = adapter.stopAll().then(() => { stopped = true; });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(body).not.toHaveBeenCalled();
      grant(true);
      await Promise.all([running, stopping]);
      expect(body).toHaveBeenCalledTimes(1);
      expect(lock.release).toHaveBeenCalledExactlyOnceWith(jobs[0].jobId);
    } finally {
      grant(false);
      await Promise.allSettled([running, stopping]);
    }
  });

  it("waits for every admitted callback even when another acquisition rejects", async () => {
    const { cron, callbacks } = timers();
    const lock = mutex();
    const failure = new Error("acquisition failed");
    let rejectAcquisition!: (error: Error) => void;
    let enter!: () => void;
    let finish!: () => void;
    const acquisition = new Promise<boolean>((_resolve, reject) => { rejectAcquisition = reject; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    lock.tryAcquire.mockImplementation((id) => id === jobs[0].jobId ? acquisition : Promise.resolve(true));
    const adapter = createNodeScheduler({ cron, jobs, lock, env: {} });
    adapter.register({ ...jobs[0], handler: vi.fn() });
    adapter.register({ ...jobs[1], handler: async () => { enter(); await pending; } });
    const first = callbacks[0]();
    const second = callbacks[1]();
    const joined = Promise.allSettled([first, second]);
    await entered;
    let stopped = false;
    const stopping = adapter.stopAll();
    const settled = stopping.then(() => { stopped = true; }, () => { stopped = true; });
    try {
      rejectAcquisition(failure);
      await expect(first).rejects.toBe(failure);
      expect(stopped).toBe(false);
      finish();
      await expect(stopping).rejects.toBe(failure);
      await joined;
      expect(lock.release).toHaveBeenCalledExactlyOnceWith(jobs[1].jobId);
    } finally {
      rejectAcquisition(failure);
      finish();
      await Promise.all([joined, settled]);
    }
  });

  it("fences every registration and attempts every stop when a timer stop throws", async () => {
    const { cron, callbacks, stops } = timers();
    const lock = mutex();
    const body = vi.fn();
    const failure = new Error("timer stop failed");
    const adapter = createNodeScheduler({ cron, jobs, lock, env: {} });
    for (const job of jobs) adapter.register({ ...job, handler: body });
    stops[0].mockImplementation(() => { throw failure; });
    const stopping = adapter.stopAll();
    const rejected = expect(stopping).rejects.toBe(failure);
    await Promise.all(callbacks.map((callback) => callback()));
    await rejected;
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
    expect(lock.tryAcquire).not.toHaveBeenCalled();
    await adapter.stopAll();
  });

  it("verifies bearer credentials and refuses a missing configured secret", () => {
    const { cron } = timers();
    const request = (authorization?: string) => ({ headers: { authorization } }) as HttpRequest;
    const adapter = createNodeScheduler({ cron, jobs, env: { CRON_SECRET: "timer-key" } });
    expect(adapter.verifyInvocation(request("Bearer timer-key"))).toBe(true);
    expect(adapter.verifyInvocation(request("Bearer other-key"))).toBe(false);
    expect(adapter.verifyInvocation(request())).toBe(false);
    expect(createNodeScheduler({ cron, jobs, env: {} }).verifyInvocation(request("Bearer timer-key"))).toBe(false);
  });
});
