import { z } from "zod";

/** Synthetic carrier-rate transport outcomes; no network, timer, or retry. */
export type ScriptedShippingRateOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "http-failure"; readonly status: number; readonly response?: T }
  | { readonly kind: "rate-limited-429"; readonly retryAfterSeconds?: number; readonly response?: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport-error" };

export class ScriptedShippingRateTransportError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly kind: Exclude<ScriptedShippingRateOutcome<never>["kind"], "success">,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`scripted_shipping_rate_transport:${kind}`);
    this.name = kind === "timeout" ? "AbortError" : "ScriptedShippingRateTransportError";
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

type RecordedFault = { readonly kind: ScriptedShippingRateOutcome<unknown>["kind"] };

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), value: z.unknown() }).refine((v) => Object.hasOwn(v, "value"), "value required"),
  z.strictObject({ kind: z.literal("http-failure"), status: z.number().int().min(100).max(599), response: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("rate-limited-429"), retryAfterSeconds: z.number().int().positive().max(86_400).optional(), response: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("timeout") }),
  z.strictObject({ kind: z.literal("transport-error") }),
]);

const authenticatedFaultLogs = new WeakMap<object, readonly RecordedFault[]>();

/** Internal authenticated log reader. Caller-fabricated arrays cannot supply transport fault evidence. */
export function readScriptedShippingRateFaultLog(handle: object): readonly RecordedFault[] {
  const log = authenticatedFaultLogs.get(handle);
  if (!log) throw new Error("SHIPPING_RATE_CONFORMANCE:invalid_fault_log");
  return log.map((row) => ({ kind: row.kind }));
}

export interface ScriptedShippingRateFake<Calls extends Record<string, unknown>> {
  readonly calls: readonly { readonly call: keyof Calls; readonly kind: ScriptedShippingRateOutcome<unknown>["kind"] }[];
  enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedShippingRateOutcome<Calls[K]>[]): void;
  invoke<K extends keyof Calls>(call: K): Promise<Calls[K]>;
  assertDrained(): void;
}

/** Per-operation FIFO transport fake. Inputs, credentials, and response bodies are never logged. */
export function createScriptedShippingRateFake<Calls extends Record<string, unknown>>(): ScriptedShippingRateFake<Calls> {
  const queues = new Map<keyof Calls, ScriptedShippingRateOutcome<Calls[keyof Calls]>[]>();
  const calls: { call: keyof Calls; kind: ScriptedShippingRateOutcome<unknown>["kind"] }[] = [];

  return Object.freeze({
    get calls() {
      const snap = Object.freeze(calls.map((row) => Object.freeze({ ...row })));
      authenticatedFaultLogs.set(snap, calls);
      return snap;
    },
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedShippingRateOutcome<Calls[K]>[]): void {
      if (!["string", "number", "symbol"].includes(typeof call)) {
        throw new Error("SHIPPING_RATE_CONFORMANCE:invalid_call_key");
      }
      const parsed = outcomes.map((o) => outcomeSchema.parse(o) as ScriptedShippingRateOutcome<Calls[K]>);
      const queue = queues.get(call) ?? [];
      queue.push(...parsed);
      queues.set(call, queue);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) throw new Error(`scripted_shipping_rate_transport:unscripted:${String(call)}`);
      calls.push({ call, kind: outcome.kind });
      if (outcome.kind === "success") return outcome.value as Calls[K];
      if (outcome.kind === "http-failure" && outcome.response !== undefined) return outcome.response as Calls[K];
      if (outcome.kind === "rate-limited-429" && outcome.response !== undefined) return outcome.response as Calls[K];
      throw new ScriptedShippingRateTransportError(outcome.kind, {
        ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}),
        ...(outcome.kind === "rate-limited-429" && outcome.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: outcome.retryAfterSeconds }
          : {}),
      });
    },
    assertDrained(): void {
      for (const [call, queue] of queues) {
        if (queue.length > 0) {
          throw new Error(`scripted_shipping_rate_transport:unconsumed:${String(call)}:${queue.length}`);
        }
      }
    },
  });
}
