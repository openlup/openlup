import type { AlertDecision } from "../../../src/domains/platform/observabilityContracts.js";
import type { AlertSinkPort } from "../../../src/domains/platform/observabilityPorts.js";

type WatchdogQueueItem = Pick<AlertDecision, "dedupeKey" | "severity" | "paging">;
const WATCHDOG_CONCURRENCY = 4;
const SEVERITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };

/**
 * Only each key's first unfinished item is eligible. A head heap prioritizes
 * normalized severity without reordering the caller's decisions or duplicates.
 */
export async function runWatchdogQueue(
  items: readonly WatchdogQueueItem[],
  process: (index: number) => Promise<void>,
): Promise<void> {
  const next = new Array<number>(items.length).fill(-1);
  const lastByKey = new Map<string, number>();
  const ready: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const previous = lastByKey.get(items[index].dedupeKey);
    if (previous === undefined) push(index);
    else next[previous] = index;
    lastByKey.set(items[index].dedupeKey, index);
  }

  let failed = false;
  let firstError: unknown;
  async function worker() {
    while (!failed) {
      const index = pop();
      if (index === undefined) return;
      try {
        await process(index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      }
      if (!failed && next[index] !== -1) push(next[index]);
    }
  }

  // Workers catch their own errors so every admitted chain settles before reject.
  await Promise.all(Array.from({ length: WATCHDOG_CONCURRENCY }, () => worker()));
  if (failed) throw firstError;

  function compare(left: number, right: number): number {
    const a = items[left];
    const b = items[right];
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      || Number(a.paging === "never") - Number(b.paging === "never")
      || a.dedupeKey.localeCompare(b.dedupeKey)
      || left - right;
  }

  function push(index: number) {
    let position = ready.length;
    ready.push(index);
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (compare(ready[parent], index) <= 0) break;
      ready[position] = ready[parent];
      position = parent;
    }
    ready[position] = index;
  }

  function pop(): number | undefined {
    if (ready.length === 0) return undefined;
    const first = ready[0];
    const last = ready.pop()!;
    if (ready.length === 0) return first;
    let position = 0;
    while (position * 2 + 1 < ready.length) {
      let child = position * 2 + 1;
      if (child + 1 < ready.length && compare(ready[child + 1], ready[child]) < 0) child += 1;
      if (compare(last, ready[child]) <= 0) break;
      ready[position] = ready[child];
      position = child;
    }
    ready[position] = last;
    return first;
  }
}

/** Per-tick transport limit; admitted waiters still run if an earlier send throws. */
export function createSerialWatchdogSink(sinkPort: AlertSinkPort): AlertSinkPort {
  let tail = Promise.resolve();
  return {
    send(decision, alert) {
      const attempt = tail.then(() => sinkPort.send(decision, alert));
      tail = attempt.then(() => undefined, () => undefined);
      return attempt;
    },
  };
}
