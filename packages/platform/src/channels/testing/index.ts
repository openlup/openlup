import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import type {
  ChannelConnectorCapabilities,
  ChannelOrderSourcePort,
  NormalizedWebhookResult,
} from "../contracts/index.js";
import { normalizedChannelOrderSchema, unmappedChannelSignalSchema } from "../orderContracts.js";

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

const channelCapabilitiesSchema = z.strictObject({
  connectorKind: z.string().trim().min(1),
  connectorShape: z.enum(["direct", "aggregator"]),
  supportsChannelDiscovery: z.boolean(),
  supportsOrderPull: z.boolean(),
  supportsOrderWebhook: z.boolean(),
  supportsOrderAck: z.boolean(),
  supportsListingLink: z.boolean(),
  supportsStockPush: z.boolean(),
  supportsPricePush: z.boolean(),
  supportsShipmentPush: z.boolean(),
  correlation: z.strictObject({
    orderRefField: z.string().trim().min(1),
    customerRefField: z.string().trim().min(1).nullable(),
    customerRefNullMeans: z.enum(["per_order_identity", "unsupported"]),
    emailIsAlwaysMasked: z.boolean(),
  }),
});

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

export interface ChannelPullFaultCertificationScenarios {
  readonly http5xx: () => ChannelPullHarness;
  readonly httpAuthFailure: () => ChannelPullHarness;
  readonly rateLimited429: () => ChannelPullHarness;
  readonly timeout: () => ChannelPullHarness;
  readonly transportError: () => ChannelPullHarness;
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
  readonly malformedWebhook?: ChannelWebhookFixture;
  readonly happyPullOrders?: () => ChannelPullHarness;
  readonly pullCertification?: ChannelPullFaultCertificationScenarios;
  readonly sensitiveValues?: readonly string[];
}

export interface ChannelQualification {
  readonly subjectId: string;
  readonly connectorKind: string;
  readonly mode: "baseline" | "full";
  readonly capabilityDigest: string;
  readonly ledger: readonly {
    readonly scenario: string;
    readonly role: "webhook" | "pull" | "pull-fault";
    readonly ioDelta: number;
    readonly faultLogDelta: number | null;
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

function rejectDeepProxy(root: unknown, location: string): void {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    rejectProxy(v, location);
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    for (const k of Reflect.ownKeys(v)) {
      let prop: unknown;
      try { prop = Reflect.get(v, k); } catch { continue; }
      walk(prop);
    }
  };
  walk(root);
}

function assertNonEmptyString(v: unknown, code: string, message: string, location: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    fail(code, message, location);
  }
  return v;
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
    if (v instanceof Error) {
      walk(v.name);
      walk(v.message);
      walk(v.stack);
      walk((v as { cause?: unknown }).cause);
    }
    if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer)) {
      walk(new TextDecoder().decode(new Uint8Array(v)));
      return;
    }
    if (ArrayBuffer.isView(v)) {
      walk(new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
      return;
    }
    if (Array.isArray(v)) { for (const i of v) walk(i); return; }
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k === "string") walk(k);
      let prop: unknown;
      try { prop = Reflect.get(v, k); } catch { continue; }
      walk(prop);
    }
  };
  walk(payload);
}

function parseCapabilities(raw: unknown, location: string): { caps: ChannelConnectorCapabilities; digest: string } {
  rejectDeepProxy(raw, location);
  const parsed = channelCapabilitiesSchema.safeParse(raw);
  if (!parsed.success) {
    fail("invalid_capabilities", parsed.error.issues[0]?.message ?? "invalid capabilities", location);
  }
  const digest = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  return { caps: parsed.data, digest };
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
    assertNonEmptyString(subject?.id, "invalid_subject_id", "Provide non-empty subject.id.", "subject");
    const loc = (s: string) => `${subject.id}:${s}`;
    const ledger: ChannelQualification["ledger"][number][] = [];

    const wh = subject.createWebhookAdapter();
    rejectProxy(wh, loc("webhook"));
    rejectProxy(wh.adapter, loc("webhook"));
    rejectProxy(wh.adapter.normalizeWebhook, loc("webhook"));
    const { caps: whCaps, digest: capabilityDigest } = parseCapabilities(wh.capabilities, loc("capabilities"));
    const signal = new AbortController().signal;

    const readValidIo = (fn: () => number, location: string): number => {
      const n = fn();
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
        fail("invalid_io_count", "readIoCount() must return a non-negative safe integer.", location);
      }
      return n;
    };

    const runWebhook = async (
      name: string,
      fixture: ChannelWebhookFixture,
      expectedKind: NormalizedWebhookResult["kind"],
      expectZeroIo: boolean,
    ): Promise<NormalizedWebhookResult> => {
      const ioBefore = readValidIo(wh.readIoCount, loc(name));
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
      rejectDeepProxy(res, loc(name));
      assertNoLeak(res, subject.sensitiveValues, loc(name));
      const ioAfter = readValidIo(wh.readIoCount, loc(name));
      const ioDelta = ioAfter - ioBefore;
      if (ioDelta < 0) fail("invalid_io_count", "readIoCount() decreased.", loc(name));
      if (expectZeroIo && ioDelta !== 0) {
        fail("zero_io_violation", `Expected 0 I/O on ${name}, observed ${ioDelta}.`, loc(name));
      }
      if (res.kind !== expectedKind) {
        fail("webhook_kind_mismatch", `Expected kind "${expectedKind}" on ${name}, observed "${String(res?.kind)}".`, loc(name));
      }
      if (res.kind === "order") {
        const eventId = assertNonEmptyString(
          res.providerEventId,
          "missing_provider_event_id",
          "order webhook result must include non-empty providerEventId.",
          loc(name),
        );
        const parsedOrder = normalizedChannelOrderSchema.safeParse(res.order);
        if (!parsedOrder.success) {
          fail("invalid_normalized_order", parsedOrder.error.issues[0]?.message ?? "invalid order", loc(name));
        }
        if (eventId !== parsedOrder.data.providerEventId) {
          fail(
            "provider_event_id_mismatch",
            "order webhook result.providerEventId must match order.providerEventId.",
            loc(name),
          );
        }
      } else if (res.kind === "unmapped") {
        assertNonEmptyString(
          res.providerEventId,
          "missing_provider_event_id",
          "unmapped webhook result must include non-empty providerEventId.",
          loc(name),
        );
        const parsedSignal = unmappedChannelSignalSchema.safeParse(res.signal);
        if (!parsedSignal.success) {
          fail("invalid_unmapped_signal", parsedSignal.error.issues[0]?.message ?? "invalid unmapped signal", loc(name));
        }
      } else if (res.kind === "ignored") {
        assertNonEmptyString(
          res.providerEventId,
          "invalid_ignored_webhook",
          "ignored webhook result must include non-empty providerEventId.",
          loc(name),
        );
        assertNonEmptyString(
          res.reason,
          "invalid_ignored_webhook",
          "ignored webhook result must include non-empty reason.",
          loc(name),
        );
      }
      ledger.push({ scenario: name, role: "webhook", ioDelta, faultLogDelta: null });
      return res;
    };

    const badSig = await runWebhook("badSignatureWebhook", subject.badSignatureWebhook, "rejected", true);
    if (badSig.kind !== "rejected" || badSig.reason !== "signature") {
      fail("bad_signature_reason", "Invalid webhook signature must return { kind: 'rejected', reason: 'signature' }.", loc("badSignatureWebhook"));
    }
    await runWebhook("validOrderWebhook", subject.validOrderWebhook, "order", true);
    await runWebhook("unmappedVocabularyWebhook", subject.unmappedVocabularyWebhook, "unmapped", true);
    await runWebhook("ignoredTopicWebhook", subject.ignoredTopicWebhook, "ignored", true);

    if (mode === "full") {
      // Full-mode webhook integrity: mutating the signed body must fail signature verification at 0 I/O
      const tamperedFixture: ChannelWebhookFixture = {
        headers: subject.validOrderWebhook.headers,
        rawBody: `${subject.validOrderWebhook.rawBody} `,
      };
      const tamperRes = await runWebhook("tamperedBodyWebhook", tamperedFixture, "rejected", true);
      if (tamperRes.kind !== "rejected" || tamperRes.reason !== "signature") {
        fail(
          "body_tamper_accepted",
          "Mutating validOrderWebhook.rawBody must return { kind: 'rejected', reason: 'signature' }.",
          loc("tamperedBodyWebhook"),
        );
      }
      if (!subject.malformedWebhook) {
        fail("missing_malformed_webhook", "mode: 'full' requires subject.malformedWebhook fixture.", loc("malformedWebhook"));
      }
      const malformedRes = await runWebhook("malformedWebhook", subject.malformedWebhook, "rejected", true);
      if (malformedRes.kind !== "rejected" || malformedRes.reason !== "malformed") {
        fail(
          "malformed_webhook_reason",
          "malformedWebhook must return { kind: 'rejected', reason: 'malformed' }.",
          loc("malformedWebhook"),
        );
      }
    }

    if (whCaps.supportsOrderPull) {
      if (!subject.happyPullOrders) {
        fail("missing_pull_harness", "supportsOrderPull: true requires happyPullOrders harness.", loc("happyPullOrders"));
      }
      const pullH = subject.happyPullOrders();
      rejectProxy(pullH, loc("happyPullOrders"));
      rejectProxy(pullH.adapter, loc("happyPullOrders"));
      rejectProxy(pullH.adapter.pullOrders, loc("happyPullOrders"));
      const pullParsedCaps = parseCapabilities(pullH.capabilities, loc("happyPullOrders"));
      if (pullParsedCaps.digest !== capabilityDigest) {
        fail("capability_drift", "happyPullOrders capabilities differ from webhook adapter capabilities.", loc("happyPullOrders"));
      }
      if (mode === "full" && !pullH.readFaultLog) {
        fail("missing_fault_log_handle", "mode: 'full' requires pullH.readFaultLog() backed by createScriptedChannelFake.", loc("happyPullOrders"));
      }
      const ioBefore = readValidIo(pullH.readIoCount, loc("happyPullOrders"));
      const faultHandle = pullH.readFaultLog ? pullH.readFaultLog() : null;
      const faultBefore = faultHandle ? readFaultLog(faultHandle).length : null;
      let pulled: Awaited<ReturnType<ChannelOrderSourcePort["pullOrders"]>>;
      try {
        pulled = await pullH.adapter.pullOrders({ ...pullH.input, signal });
      } catch (err) {
        assertNoLeak(err, subject.sensitiveValues, loc("happyPullOrders"));
        fail("pull_threw", "happyPullOrders threw an unexpected exception.", loc("happyPullOrders"));
      }
      rejectDeepProxy(pulled, loc("happyPullOrders"));
      assertNoLeak(pulled, subject.sensitiveValues, loc("happyPullOrders"));
      if (!Array.isArray(pulled.orders) || pulled.orders.length === 0) {
        fail("empty_pulled_orders", "happyPullOrders must return at least 1 normalized order.", loc("happyPullOrders"));
      }
      for (const order of pulled.orders) {
        const parsed = normalizedChannelOrderSchema.safeParse(order);
        if (!parsed.success) fail("invalid_pulled_order", parsed.error.issues[0]?.message ?? "invalid order", loc("happyPullOrders"));
      }
      if (!Array.isArray(pulled.unmapped)) {
        fail("invalid_pulled_unmapped", "pullOrders().unmapped must be an array (B3 unmapped preservation).", loc("happyPullOrders"));
      }
      for (const item of pulled.unmapped) {
        const parsedSignal = unmappedChannelSignalSchema.safeParse(item);
        if (!parsedSignal.success) {
          fail("invalid_pulled_unmapped", parsedSignal.error.issues[0]?.message ?? "invalid unmapped signal", loc("happyPullOrders"));
        }
      }
      if (pulled.nextCursor !== null && (typeof pulled.nextCursor !== "string" || pulled.nextCursor.trim().length === 0)) {
        fail("invalid_pull_cursor", "pullOrders().nextCursor must be null or a non-empty string.", loc("happyPullOrders"));
      }
      if (
        pulled.watermarkAt !== null &&
        (typeof pulled.watermarkAt !== "string" || !z.string().datetime({ offset: true }).safeParse(pulled.watermarkAt).success)
      ) {
        fail("invalid_pull_watermark", "pullOrders().watermarkAt must be null or an ISO-8601 timestamp string with offset.", loc("happyPullOrders"));
      }
      const ioAfter = readValidIo(pullH.readIoCount, loc("happyPullOrders"));
      const ioDelta = ioAfter - ioBefore;
      if (ioDelta < 1) fail("pull_io_missing", "happyPullOrders must execute at least 1 provider I/O call.", loc("happyPullOrders"));
      let faultLogDelta: number | null = null;
      if (faultHandle && faultBefore !== null) {
        const added = readFaultLog(faultHandle).slice(faultBefore);
        if (added.length < 1 || !added.every((entry) => entry.kind === "success")) {
          fail("pull_fault_log_missing", "Authenticated fake log must record >=1 success entry on happyPullOrders.", loc("happyPullOrders"));
        }
        faultLogDelta = added.length;
      }
      ledger.push({ scenario: "happyPullOrders", role: "pull", ioDelta, faultLogDelta });

      if (mode === "full") {
        if (!subject.pullCertification) {
          fail(
            "missing_pull_certification",
            "mode: 'full' with supportsOrderPull: true requires subject.pullCertification scenarios.",
            loc("pullCertification"),
          );
        }
        rejectProxy(subject.pullCertification, loc("pullCertification"));
        const faultSpecs = [
          {
            name: "pull-http-5xx",
            factory: subject.pullCertification.http5xx,
            check: (f: RecordedChannelFault) => f.kind === "http-failure" && (f.status ?? 0) >= 500,
          },
          {
            name: "pull-http-auth-failure",
            factory: subject.pullCertification.httpAuthFailure,
            check: (f: RecordedChannelFault) => f.kind === "http-failure" && (f.status === 401 || f.status === 403),
          },
          {
            name: "pull-rate-limited-429",
            factory: subject.pullCertification.rateLimited429,
            check: (f: RecordedChannelFault) => f.kind === "rate-limited-429",
          },
          {
            name: "pull-timeout",
            factory: subject.pullCertification.timeout,
            check: (f: RecordedChannelFault) => f.kind === "timeout",
          },
          {
            name: "pull-transport-error",
            factory: subject.pullCertification.transportError,
            check: (f: RecordedChannelFault) => f.kind === "transport-error",
          },
        ] as const;

        for (const spec of faultSpecs) {
          const fh = spec.factory();
          rejectProxy(fh, loc(spec.name));
          rejectProxy(fh.adapter, loc(spec.name));
          rejectProxy(fh.adapter.pullOrders, loc(spec.name));
          const fhCaps = parseCapabilities(fh.capabilities, loc(spec.name));
          if (fhCaps.digest !== capabilityDigest) {
            fail("capability_drift", `${spec.name} capabilities differ from webhook adapter capabilities.`, loc(spec.name));
          }
          if (!fh.readFaultLog) {
            fail("missing_fault_log_handle", `mode: 'full' requires readFaultLog() on ${spec.name}.`, loc(spec.name));
          }
          const fIoBefore = readValidIo(fh.readIoCount, loc(spec.name));
          const fHandle = fh.readFaultLog();
          const fBefore = readFaultLog(fHandle).length;
          let threw = false;
          let swallowedOut: unknown;
          try {
            swallowedOut = await fh.adapter.pullOrders({ ...fh.input, signal });
          } catch (err) {
            threw = true;
            assertNoLeak(err, subject.sensitiveValues, loc(spec.name));
          }
          if (!threw) {
            rejectDeepProxy(swallowedOut, loc(spec.name));
            assertNoLeak(swallowedOut, subject.sensitiveValues, loc(spec.name));
            fail("pull_fault_swallowed", `pullOrders() must reject on ${spec.name} instead of swallowing the transport fault.`, loc(spec.name));
          }
          const fIoAfter = readValidIo(fh.readIoCount, loc(spec.name));
          const fIoDelta = fIoAfter - fIoBefore;
          const addedFaults = readFaultLog(fHandle).slice(fBefore);
          if (fIoDelta !== 1 || addedFaults.length !== 1 || !spec.check(addedFaults[0]!)) {
            fail("pull_fault_mismatch", `Expected 1 authenticated ${spec.name} fault with ioDelta=1.`, loc(spec.name));
          }
          ledger.push({ scenario: spec.name, role: "pull-fault", ioDelta: fIoDelta, faultLogDelta: addedFaults.length });
        }
      }
    }

    qualifications.push({
      subjectId: subject.id,
      connectorKind: whCaps.connectorKind,
      mode,
      capabilityDigest,
      ledger,
    });
  }

  return { contractVersion: "channel.order.v1", mode, qualifications };
}
