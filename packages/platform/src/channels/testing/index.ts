import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import type {
  ChannelConnectorCapabilities,
  ChannelOrderSourcePort,
  NormalizedWebhookResult,
} from "../contracts/index.js";
import { normalizedChannelOrderSchema } from "../orderContracts.js";

/** @experimental Offline sales-channel connector conformance runner and scripted transport fake. */

export type ScriptedChannelOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "http-failure"; readonly status: number; readonly response?: T }
  | { readonly kind: "rate-limited-429"; readonly retryAfterSeconds?: number; readonly response?: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport-error" };

export class ScriptedChannelTransportError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly kind: Exclude<ScriptedChannelOutcome<never>["kind"], "success">,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`scripted_channel_transport:${kind}`);
    this.name = kind === "timeout" ? "AbortError" : "ScriptedChannelTransportError";
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

interface RecordedChannelFault {
  readonly kind: ScriptedChannelOutcome<unknown>["kind"] | "unscripted";
  readonly status?: number;
}

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), value: z.unknown() }).refine((v) => Object.hasOwn(v, "value"), "value required"),
  z.strictObject({ kind: z.literal("http-failure"), status: z.number().int().min(100).max(599), response: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("rate-limited-429"), retryAfterSeconds: z.number().int().positive().max(86_400).optional(), response: z.unknown().optional() }),
  z.strictObject({ kind: z.literal("timeout") }),
  z.strictObject({ kind: z.literal("transport-error") }),
]);

const faultLogs = new WeakMap<object, readonly RecordedChannelFault[]>();

function readFaultLog(handle: object): readonly RecordedChannelFault[] {
  const log = faultLogs.get(handle);
  if (!log) throw new Error("CHANNEL_CONFORMANCE:invalid_fault_log");
  return log.map((r) => ({ ...r }));
}

export interface ScriptedChannelFake<Calls extends Record<string, unknown>> {
  readonly calls: readonly { readonly call: keyof Calls; readonly kind: ScriptedChannelOutcome<unknown>["kind"] | "unscripted" }[];
  enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedChannelOutcome<Calls[K]>[]): void;
  invoke<K extends keyof Calls>(call: K): Promise<Calls[K]>;
  assertDrained(): void;
}

export function createScriptedChannelFake<Calls extends Record<string, unknown>>(): ScriptedChannelFake<Calls> {
  const queues = new Map<keyof Calls, ScriptedChannelOutcome<Calls[keyof Calls]>[]>();
  const calls: { call: keyof Calls; kind: ScriptedChannelOutcome<unknown>["kind"] | "unscripted" }[] = [];
  const faults: RecordedChannelFault[] = [];
  return Object.freeze({
    get calls() {
      const snap = Object.freeze(calls.map((r) => Object.freeze({ ...r })));
      faultLogs.set(snap, faults);
      return snap;
    },
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedChannelOutcome<Calls[K]>[]): void {
      const parsed = outcomes.map((o) => outcomeSchema.parse(o) as ScriptedChannelOutcome<Calls[K]>);
      const q = queues.get(call) ?? [];
      q.push(...parsed);
      queues.set(call, q);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) {
        calls.push({ call, kind: "unscripted" });
        faults.push({ kind: "unscripted" });
        throw new Error(`scripted_channel_transport:unscripted:${String(call)}`);
      }
      calls.push({ call, kind: outcome.kind });
      faults.push({ kind: outcome.kind, ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}) });
      if (outcome.kind === "success") return outcome.value as Calls[K];
      if ((outcome.kind === "http-failure" || outcome.kind === "rate-limited-429") && outcome.response !== undefined) {
        return outcome.response as Calls[K];
      }
      throw new ScriptedChannelTransportError(outcome.kind, {
        ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}),
        ...(outcome.kind === "rate-limited-429" && outcome.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: outcome.retryAfterSeconds }
          : {}),
      });
    },
    assertDrained(): void {
      for (const [call, q] of queues) {
        if (q.length > 0) throw new Error(`scripted_channel_transport:unconsumed:${String(call)}:${q.length}`);
      }
    },
  });
}

export interface ChannelWebhookFixture {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

export interface ChannelPullHarness {
  readonly adapter: ChannelOrderSourcePort;
  readonly capabilities: ChannelConnectorCapabilities;
  readonly input: {
    readonly connectionRef: string;
    readonly channelExternalRef: string | null;
    readonly since: string | null;
    readonly cursor: string | null;
    readonly limit: number;
  };
  readIoCount(): number;
  readFaultLog?(): object;
}

export interface ChannelAdapterTestSubject {
  readonly id: string;
  readonly createWebhookAdapter: () => {
    readonly adapter: ChannelOrderSourcePort;
    readonly capabilities: ChannelConnectorCapabilities;
    readIoCount(): number;
  };
  readonly validOrderWebhook: ChannelWebhookFixture;
  readonly badSignatureWebhook: ChannelWebhookFixture;
  readonly unmappedVocabularyWebhook: ChannelWebhookFixture;
  readonly ignoredTopicWebhook: ChannelWebhookFixture;
  readonly happyPullOrders?: () => ChannelPullHarness;
  readonly sensitiveValues?: readonly string[];
}

export interface ChannelQualification {
  readonly subjectId: string;
  readonly connectorKind: string;
  readonly mode: "baseline" | "full";
  readonly capabilityDigest: string;
  readonly ledger: readonly {
    readonly scenario: string;
    readonly role: "webhook" | "pull";
    readonly ioDelta: number;
  }[];
}

export interface ChannelConformanceEvidence {
  readonly contractVersion: "channel.order.v1";
  readonly mode: "baseline" | "full";
  readonly qualifications: readonly ChannelQualification[];
}

function fail(code: string, message: string, location: string): never {
  throw new Error(`CHANNEL_CONFORMANCE:${code}. ${message} Location: ${location}`);
}

function rejectProxy(v: unknown, location: string): void {
  if (((typeof v === "object" && v !== null) || typeof v === "function") && types.isProxy(v)) {
    fail("proxy_rejected", "Proxy subjects, adapters, harnesses, or results are forbidden.", location);
  }
}

function assertNoLeak(payload: unknown, sensitive: readonly string[] | undefined, location: string): void {
  if (!sensitive || sensitive.length === 0) return;
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      for (const s of sensitive) {
        if (s.length < 4) continue;
        const enc = encodeURIComponent(s);
        if (v.includes(s) || v.includes(enc) || lower.includes(enc.toLowerCase())) {
          fail("secret_leak", "Sensitive canary leaked into channel output or error.", location);
        }
      }
      return;
    }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const i of v) walk(i); return; }
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k === "string") walk(k);
      try { walk(Reflect.get(v, k)); } catch { /* ignore */ }
    }
  };
  walk(payload);
}

export async function runChannelAdapterConformance(
  subjects: readonly ChannelAdapterTestSubject[],
  options?: { readonly mode?: "baseline" | "full" },
): Promise<ChannelConformanceEvidence> {
  rejectProxy(subjects, "subjects");
  if (!Array.isArray(subjects) || subjects.length === 0) fail("empty_subjects", "Supply at least one subject.", "subjects");
  const mode = options?.mode ?? "baseline";
  const qualifications: ChannelQualification[] = [];

  for (const subject of subjects) {
    rejectProxy(subject, `subject:${subject?.id ?? "unknown"}`);
    if (!subject.id || !subject.id.trim()) fail("invalid_subject_id", "Provide non-empty subject.id.", "subject");
    const loc = (s: string) => `${subject.id}:${s}`;
    const ledger: ChannelQualification["ledger"][number][] = [];

    const wh = subject.createWebhookAdapter();
    rejectProxy(wh, loc("webhook"));
    rejectProxy(wh.adapter, loc("webhook"));
    rejectProxy(wh.capabilities, loc("webhook"));
    if (!wh.capabilities.connectorKind || !wh.capabilities.connectorKind.trim()) {
      fail("invalid_capabilities", "connectorKind must be non-empty.", loc("capabilities"));
    }
    const capabilityDigest = createHash("sha256").update(JSON.stringify(wh.capabilities)).digest("hex");
    const signal = new AbortController().signal;

    const runWebhook = async (
      name: string,
      fixture: ChannelWebhookFixture,
      expectedKind: NormalizedWebhookResult["kind"],
      expectZeroIo: boolean,
    ): Promise<NormalizedWebhookResult> => {
      const ioBefore = wh.readIoCount();
      let res: NormalizedWebhookResult;
      try {
        res = await wh.adapter.normalizeWebhook({
          headers: fixture.headers,
          rawBody: fixture.rawBody,
          signal,
        });
      } catch (err) {
        assertNoLeak(err, subject.sensitiveValues, loc(name));
        fail("webhook_threw", `normalizeWebhook() threw on ${name}; must return structured NormalizedWebhookResult.`, loc(name));
      }
      rejectProxy(res, loc(name));
      assertNoLeak(res, subject.sensitiveValues, loc(name));
      const ioDelta = wh.readIoCount() - ioBefore;
      if (expectZeroIo && ioDelta !== 0) {
        fail("zero_io_violation", `Expected 0 I/O on ${name}, observed ${ioDelta}.`, loc(name));
      }
      if (res.kind !== expectedKind) {
        fail("webhook_kind_mismatch", `Expected kind "${expectedKind}" on ${name}, observed "${res.kind}".`, loc(name));
      }
      if (res.kind === "order") {
        const parsedOrder = normalizedChannelOrderSchema.safeParse(res.order);
        if (!parsedOrder.success) {
          fail("invalid_normalized_order", parsedOrder.error.issues[0]?.message ?? "invalid order", loc(name));
        }
      }
      ledger.push({ scenario: name, role: "webhook", ioDelta });
      return res;
    };

    const badSig = await runWebhook("badSignatureWebhook", subject.badSignatureWebhook, "rejected", true);
    if (badSig.kind !== "rejected" || badSig.reason !== "signature") {
      fail("bad_signature_reason", "Invalid webhook signature must return { kind: 'rejected', reason: 'signature' }.", loc("badSignatureWebhook"));
    }
    await runWebhook("validOrderWebhook", subject.validOrderWebhook, "order", true);
    await runWebhook("unmappedVocabularyWebhook", subject.unmappedVocabularyWebhook, "unmapped", true);
    await runWebhook("ignoredTopicWebhook", subject.ignoredTopicWebhook, "ignored", true);

    if (wh.capabilities.supportsOrderPull) {
      if (!subject.happyPullOrders) {
        fail("missing_pull_harness", "supportsOrderPull: true requires happyPullOrders harness.", loc("happyPullOrders"));
      }
      const pullH = subject.happyPullOrders();
      rejectProxy(pullH, loc("happyPullOrders"));
      rejectProxy(pullH.adapter, loc("happyPullOrders"));
      const ioBefore = pullH.readIoCount();
      const faultHandle = pullH.readFaultLog ? pullH.readFaultLog() : null;
      const faultBefore = faultHandle ? readFaultLog(faultHandle).length : null;
      const pulled = await pullH.adapter.pullOrders({ ...pullH.input, signal });
      assertNoLeak(pulled, subject.sensitiveValues, loc("happyPullOrders"));
      for (const order of pulled.orders) {
        const parsed = normalizedChannelOrderSchema.safeParse(order);
        if (!parsed.success) fail("invalid_pulled_order", parsed.error.issues[0]?.message ?? "invalid order", loc("happyPullOrders"));
      }
      const ioDelta = pullH.readIoCount() - ioBefore;
      if (ioDelta < 1) fail("pull_io_missing", "happyPullOrders must execute at least 1 provider I/O call.", loc("happyPullOrders"));
      if (faultHandle && faultBefore !== null && readFaultLog(faultHandle).length - faultBefore < 1) {
        fail("pull_fault_log_missing", "Authenticated fake log did not record pullOrders call.", loc("happyPullOrders"));
      }
      ledger.push({ scenario: "happyPullOrders", role: "pull", ioDelta });
    }

    qualifications.push({
      subjectId: subject.id,
      connectorKind: wh.capabilities.connectorKind,
      mode,
      capabilityDigest,
      ledger,
    });
  }

  return { contractVersion: "channel.order.v1", mode, qualifications };
}
