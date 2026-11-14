/** Synthetic transport outcomes; no provider SDK, network, timer or retry. */
export type ScriptedPaymentOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "provider-5xx"; response?: T }
  | { kind: "timeout-before-dispatch" }
  | { kind: "timeout-after-dispatch" }
  | { kind: "redelivery-409"; response?: T };

export class ScriptedPaymentTransportError extends Error {
  readonly status: number | undefined;
  readonly dispatched: boolean;
  constructor(readonly kind: Exclude<ScriptedPaymentOutcome<never>["kind"], "success">) {
    super(`scripted_payment_transport:${kind}`);
    this.name = kind.startsWith("timeout") ? "AbortError" : "ScriptedPaymentTransportError";
    this.status = kind === "provider-5xx" ? 503 : kind === "redelivery-409" ? 409 : undefined;
    this.dispatched = kind === "timeout-after-dispatch";
  }
}

/** Per-call FIFO extracted from adapter test clients. Arguments/secrets are never recorded.
 * HTTP bindings may supply a response for 5xx/409; SDK bindings receive an error.
 * Dispatch observations describe the script only, never production no-charge evidence.
 */
export function createScriptedPaymentFake<Calls extends Record<string, unknown>>() {
  const queues = new Map<keyof Calls, ScriptedPaymentOutcome<Calls[keyof Calls]>[]>();
  const calls: { call: keyof Calls; kind: ScriptedPaymentOutcome<unknown>["kind"] }[] = [];
  return {
    calls: calls as readonly { call: keyof Calls; kind: ScriptedPaymentOutcome<unknown>["kind"] }[],
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedPaymentOutcome<Calls[K]>[]): void {
      const queue = queues.get(call) ?? [];
      queue.push(...outcomes);
      queues.set(call, queue);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) throw new Error(`scripted_payment_transport:unscripted:${String(call)}`);
      calls.push({ call, kind: outcome.kind });
      if (outcome.kind === "success") return outcome.value as Calls[K];
      if ("response" in outcome && outcome.response !== undefined) return outcome.response as Calls[K];
      throw new ScriptedPaymentTransportError(outcome.kind);
    },
    assertDrained(): void {
      for (const [call, queue] of queues) {
        if (queue.length) throw new Error(`scripted_payment_transport:unconsumed:${String(call)}:${queue.length}`);
      }
    },
  };
}
