/** Synthetic transport outcomes; no network, timer or retry. */
export type ScriptedFulfillmentOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "http-failure"; status: number; response?: T }
  | { kind: "transport-before-submission" }
  | { kind: "transport-after-submission" };

/** Script metadata alone never proves that a real adapter did not submit. */
export class ScriptedFulfillmentTransportError extends Error {
  readonly mayHaveSucceeded: boolean;
  readonly submissionAttempted: boolean;
  constructor(readonly kind: Exclude<ScriptedFulfillmentOutcome<never>["kind"], "success">, readonly status?: number) {
    super(`scripted_fulfillment_transport:${kind}`);
    this.name = kind === "http-failure" ? "ScriptedFulfillmentTransportError" : "AbortError";
    this.submissionAttempted = kind === "transport-after-submission";
    this.mayHaveSucceeded = this.submissionAttempted;
  }
}

/** Per-operation FIFO. Inputs, credentials and response bodies are never logged. */
export function createScriptedFulfillmentFake<Calls extends Record<string, unknown>>() {
  const queues = new Map<keyof Calls, ScriptedFulfillmentOutcome<Calls[keyof Calls]>[]>();
  const calls: { call: keyof Calls; kind: ScriptedFulfillmentOutcome<unknown>["kind"] }[] = [];
  return {
    calls: calls as readonly { call: keyof Calls; kind: ScriptedFulfillmentOutcome<unknown>["kind"] }[],
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedFulfillmentOutcome<Calls[K]>[]): void {
      const queue = queues.get(call) ?? [];
      queue.push(...outcomes); queues.set(call, queue);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) throw new Error(`scripted_fulfillment_transport:unscripted:${String(call)}`);
      calls.push({ call, kind: outcome.kind });
      if (outcome.kind === "success") return outcome.value as Calls[K];
      if (outcome.kind === "http-failure" && outcome.response !== undefined) return outcome.response as Calls[K];
      throw new ScriptedFulfillmentTransportError(outcome.kind, outcome.kind === "http-failure" ? outcome.status : undefined);
    },
    assertDrained(): void {
      for (const [call, queue] of queues) if (queue.length) throw new Error(`scripted_fulfillment_transport:unconsumed:${String(call)}:${queue.length}`);
    },
  };
}
