import { z } from "zod";

/** Synthetic communications transport outcomes; no network, timer, or retry. */
export type ScriptedCommunicationsOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "http-failure"; readonly status: number; readonly response?: T }
  | { readonly kind: "rate-limited-429"; readonly retryAfterSeconds?: number; readonly response?: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport-error" };

export class ScriptedCommunicationsTransportError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly kind: Exclude<ScriptedCommunicationsOutcome<never>["kind"], "success">,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`scripted_communications_transport:${kind}`);
    this.name = kind === "timeout" ? "AbortError" : "ScriptedCommunicationsTransportError";
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface RecordedCommunicationsFault {
  readonly kind: ScriptedCommunicationsOutcome<unknown>["kind"] | "unscripted";
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), value: z.unknown() }).refine((v) => Object.hasOwn(v, "value"), "value required"),
  z.strictObject({ kind: z.literal("http-failure"), status: z.number().int().min(100).max(599), response: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("rate-limited-429"), retryAfterSeconds: z.number().int().positive().max(86_400).optional(), response: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("timeout") }),
  z.strictObject({ kind: z.literal("transport-error") }),
]);

const authenticatedFaultLogs = new WeakMap<object, readonly RecordedCommunicationsFault[]>();

/** Internal authenticated log reader. Caller-fabricated arrays cannot supply transport fault evidence. */
export function readScriptedCommunicationsFaultLog(handle: object): readonly RecordedCommunicationsFault[] {
  const log = authenticatedFaultLogs.get(handle);
  if (!log) throw new Error("COMMUNICATIONS_CONFORMANCE:invalid_fault_log");
  return log.map((row) => ({
    kind: row.kind,
    ...(row.status !== undefined ? { status: row.status } : {}),
    ...(row.retryAfterSeconds !== undefined ? { retryAfterSeconds: row.retryAfterSeconds } : {}),
  }));
}

export interface ScriptedCommunicationsFake<Calls extends Record<string, unknown>> {
  readonly calls: readonly {
    readonly call: keyof Calls;
    readonly kind: ScriptedCommunicationsOutcome<unknown>["kind"] | "unscripted";
  }[];
  enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedCommunicationsOutcome<Calls[K]>[]): void;
  invoke<K extends keyof Calls>(call: K): Promise<Calls[K]>;
  assertDrained(): void;
}

/** Per-operation FIFO transport fake. Inputs, credentials, and response bodies are never logged. */
export function createScriptedCommunicationsFake<Calls extends Record<string, unknown>>(): ScriptedCommunicationsFake<Calls> {
  const queues = new Map<keyof Calls, ScriptedCommunicationsOutcome<Calls[keyof Calls]>[]>();
  const calls: {
    call: keyof Calls;
    kind: ScriptedCommunicationsOutcome<unknown>["kind"] | "unscripted";
  }[] = [];
  const faults: RecordedCommunicationsFault[] = [];

  return Object.freeze({
    get calls() {
      const snap = Object.freeze(calls.map((row) => Object.freeze({ ...row })));
      authenticatedFaultLogs.set(snap, faults);
      return snap;
    },
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedCommunicationsOutcome<Calls[K]>[]): void {
      if (!["string", "number", "symbol"].includes(typeof call)) {
        throw new Error("COMMUNICATIONS_CONFORMANCE:invalid_call_key");
      }
      const parsed = outcomes.map((o) => outcomeSchema.parse(o) as ScriptedCommunicationsOutcome<Calls[K]>);
      const queue = queues.get(call) ?? [];
      queue.push(...parsed);
      queues.set(call, queue);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) {
        calls.push({ call, kind: "unscripted" });
        faults.push({ kind: "unscripted" });
        throw new Error(`scripted_communications_transport:unscripted:${String(call)}`);
      }
      calls.push({ call, kind: outcome.kind });
      faults.push({
        kind: outcome.kind,
        ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}),
        ...(outcome.kind === "rate-limited-429" && outcome.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: outcome.retryAfterSeconds }
          : {}),
      });
      if (outcome.kind === "success") return outcome.value as Calls[K];
      if (outcome.kind === "http-failure" && outcome.response !== undefined) return outcome.response as Calls[K];
      if (outcome.kind === "rate-limited-429" && outcome.response !== undefined) return outcome.response as Calls[K];
      throw new ScriptedCommunicationsTransportError(outcome.kind, {
        ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}),
        ...(outcome.kind === "rate-limited-429" && outcome.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: outcome.retryAfterSeconds }
          : {}),
      });
    },
    assertDrained(): void {
      for (const [call, queue] of queues) {
        if (queue.length > 0) {
          throw new Error(`scripted_communications_transport:unconsumed:${String(call)}:${queue.length}`);
        }
      }
    },
  });
}
