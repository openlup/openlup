import type { AlertDecision, AlertLedgerPort, OpenAlert } from "../contracts/index.js";

/** The zero-based index within the request correlates an outcome to its input. */
export type WatchdogAlertBatchOutcome =
  | { index: number; kind: "persisted"; alert: OpenAlert }
  | { index: number; kind: "failed"; error: unknown };

const MAX_BATCH_SIZE = 4;

/**
 * Create once per watchdog run. Only upserts already admitted by the watchdog
 * are batched. The watchdog still serializes complete decision chains per key.
 */
export function createBatchedWatchdogAlertUpsert<Input, Channel extends string = string>({ prepare, persist }: {
  /** Capture a detached store input before the call yields. */
  prepare(decision: AlertDecision<Channel>, now: Date): Input;
  /** Apply the existing store transition and return one outcome per input. */
  persist(inputs: readonly Input[]): Promise<readonly WatchdogAlertBatchOutcome[]>;
}): AlertLedgerPort<Channel>["upsertOpenAlert"] {
  type Pending = {
    input: Input;
    dedupeKey: string;
    severity: AlertDecision["severity"];
    resolve: (alert: OpenAlert) => void;
    reject: (error: unknown) => void;
  };
  let pending: Pending[] = [];

  async function flush(batch: Pending[]): Promise<void> {
    try {
      const reply = await persist(batch.map(({ input }) => input));
      if (!Array.isArray(reply) || reply.length !== batch.length) throw invalidReply();
      const byIndex = new Map<number, WatchdogAlertBatchOutcome>();
      for (const outcome of reply) {
        if (!outcome || !Number.isInteger(outcome.index) || outcome.index < 0
            || outcome.index >= batch.length || byIndex.has(outcome.index)) throw invalidReply();
        const request = batch[outcome.index];
        if (outcome.kind === "persisted") {
          const alert = outcome.alert;
          if (!alert || typeof alert.id !== "string" || !alert.id || alert.dedupeKey !== request.dedupeKey
              || alert.severity !== request.severity || (alert.status !== "open" && alert.status !== "acknowledged"))
            throw invalidReply();
        } else if (outcome.kind !== "failed" || !("error" in outcome)) throw invalidReply();
        byIndex.set(outcome.index, outcome);
      }
      const ordered = batch.map((_, index) => byIndex.get(index)!);
      // A suppressed success can finish immediately, so signal all failures
      // before successful peers free their admission slots.
      for (const outcome of ordered) {
        if (outcome.kind === "failed") batch[outcome.index].reject(outcome.error);
      }
      for (const outcome of ordered) {
        if (outcome.kind === "persisted") batch[outcome.index].resolve(outcome.alert);
      }
    } catch (error) {
      for (const request of batch) request.reject(error);
    }
  }

  return async (decision, now) => {
    const { dedupeKey, severity } = decision;
    const input = prepare(decision, now);
    return new Promise<OpenAlert>((resolve, reject) => {
      pending.push({ input, dedupeKey, severity, resolve, reject });
      if (pending.length !== 1) return;
      queueMicrotask(() => {
        const ready = pending;
        pending = [];
        for (let offset = 0; offset < ready.length; offset += MAX_BATCH_SIZE) {
          void flush(ready.slice(offset, offset + MAX_BATCH_SIZE));
        }
      });
    });
  };
}

function invalidReply(): Error {
  return new Error("watchdog_alert_batch_response_invalid");
}
