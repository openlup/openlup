import { expect, it } from "vitest";
import { runWatchdogQueue, createSerialWatchdogSink } from "../../src/operations/server/platformWatchdogQueue.js";
import type { AlertDecision, OpenAlert } from "../../src/operations/contracts/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const item = (dedupeKey: string, severity: "p0" | "p1" | "p2" | "p3" = "p0") => ({ dedupeKey, severity });

it("prioritizes severity, bounds work and serializes repeated dedupe keys", async () => {
  const holds = Array.from({ length: 7 }, deferred);
  const started: number[] = [];
  let active = 0;
  let maximum = 0;
  const execution = runWatchdogQueue([item("z", "p3"), item("same"), item("same"), item("a"), item("b"), item("c"), item("d")], async (index) => {
    started.push(index); active += 1; maximum = Math.max(active, maximum);
    await holds[index].promise; active -= 1;
  });
  expect(started).toEqual([3, 4, 5, 6]);
  holds[3].resolve(); await Promise.resolve(); await Promise.resolve();
  expect(started).toEqual([3, 4, 5, 6, 1]);
  expect(started).not.toContain(2);
  holds[1].resolve(); await Promise.resolve(); await Promise.resolve();
  expect(started).toContain(2);
  for (const hold of holds) hold.resolve();
  await execution;
  expect(maximum).toBe(4);
  expect(started.indexOf(1)).toBeLessThan(started.indexOf(2));
});

it("stops admission on failure and drains already admitted work before rejecting", async () => {
  const held = deferred();
  const started: number[] = [];
  const failure = new Error("synthetic failure");
  let settled = false;
  const result = runWatchdogQueue([item("a"), item("b"), item("c"), item("d"), item("e")], async (index) => {
    started.push(index);
    if (index === 0) throw failure;
    await held.promise;
  }).then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
  await Promise.resolve(); await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  expect(settled).toBe(false);
  held.resolve();
  expect(await result).toBe(failure);
  expect(started).not.toContain(4);
});

it("serializes sink calls while allowing an admitted waiter after a transport exception", async () => {
  const first = deferred();
  const started: string[] = [];
  const sink = createSerialWatchdogSink({ async send(decision) {
    started.push(decision.dedupeKey);
    if (decision.dedupeKey === "first") { await first.promise; throw new Error("synthetic transport"); }
    return { channel: "webhook", status: "sent" };
  } });
  const decision = (dedupeKey: string) => ({ dedupeKey } as AlertDecision);
  const failure = sink.send(decision("first"), {} as OpenAlert).catch((error: unknown) => error);
  const next = sink.send(decision("next"), {} as OpenAlert);
  await Promise.resolve();
  expect(started).toEqual(["first"]);
  first.resolve();
  expect(await failure).toBeInstanceOf(Error);
  expect(await next).toEqual({ channel: "webhook", status: "sent" });
  expect(started).toEqual(["first", "next"]);
});
