import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import {
  projectTelemetryStaticCapabilities,
  TELEMETRY_CONTRACT_VERSION,
  telemetryCapabilitiesSchema,
  telemetryFlushResultSchema,
  type TelemetryCapabilities,
  type TelemetryEvent,
  type TelemetryFlushResult,
  type TelemetryPort,
} from "../index.js";

/** @experimental Offline observability telemetry conformance runner and scripted sink fake. */

export type ScriptedTelemetryOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "http-failure"; readonly status: number }
  | { readonly kind: "rate-limited-429"; readonly retryAfterSeconds?: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport-error" };

export class ScriptedTelemetryTransportError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly kind: Exclude<ScriptedTelemetryOutcome<never>["kind"], "success">,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`scripted_telemetry_transport:${kind}`);
    this.name = kind === "timeout" ? "AbortError" : "ScriptedTelemetryTransportError";
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

interface RecordedTelemetryFault {
  readonly kind: ScriptedTelemetryOutcome<unknown>["kind"] | "unscripted";
  readonly status?: number;
}

const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), value: z.unknown() }).refine((v) => Object.hasOwn(v, "value"), "value required"),
  z.strictObject({ kind: z.literal("http-failure"), status: z.number().int().min(100).max(599) }),
  z.strictObject({ kind: z.literal("rate-limited-429"), retryAfterSeconds: z.number().int().positive().max(86_400).optional() }),
  z.strictObject({ kind: z.literal("timeout") }),
  z.strictObject({ kind: z.literal("transport-error") }),
]);

const faultLogs = new WeakMap<object, readonly RecordedTelemetryFault[]>();

function readFaultLog(handle: object): readonly RecordedTelemetryFault[] {
  const log = faultLogs.get(handle);
  if (!log) throw new Error("TELEMETRY_CONFORMANCE:invalid_fault_log");
  return log.map((r) => ({ ...r }));
}

export interface ScriptedTelemetryFake<Calls extends Record<string, unknown>> {
  readonly calls: readonly { readonly call: keyof Calls; readonly kind: ScriptedTelemetryOutcome<unknown>["kind"] | "unscripted" }[];
  enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedTelemetryOutcome<Calls[K]>[]): void;
  invoke<K extends keyof Calls>(call: K): Promise<Calls[K]>;
  assertDrained(): void;
}

export function createScriptedTelemetryFake<Calls extends Record<string, unknown>>(): ScriptedTelemetryFake<Calls> {
  const queues = new Map<keyof Calls, ScriptedTelemetryOutcome<Calls[keyof Calls]>[]>();
  const calls: { call: keyof Calls; kind: ScriptedTelemetryOutcome<unknown>["kind"] | "unscripted" }[] = [];
  const faults: RecordedTelemetryFault[] = [];
  return Object.freeze({
    get calls() {
      const snap = Object.freeze(calls.map((r) => Object.freeze({ ...r })));
      faultLogs.set(snap, faults);
      return snap;
    },
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedTelemetryOutcome<Calls[K]>[]): void {
      const parsed = outcomes.map((o) => outcomeSchema.parse(o) as ScriptedTelemetryOutcome<Calls[K]>);
      const q = queues.get(call) ?? [];
      q.push(...parsed);
      queues.set(call, q);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) {
        calls.push({ call, kind: "unscripted" });
        faults.push({ kind: "unscripted" });
        throw new Error(`scripted_telemetry_transport:unscripted:${String(call)}`);
      }
      calls.push({ call, kind: outcome.kind });
      faults.push({ kind: outcome.kind, ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}) });
      if (outcome.kind === "success") return outcome.value as Calls[K];
      throw new ScriptedTelemetryTransportError(outcome.kind, {
        ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}),
        ...(outcome.kind === "rate-limited-429" && outcome.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: outcome.retryAfterSeconds }
          : {}),
      });
    },
    assertDrained(): void {
      for (const [call, q] of queues) {
        if (q.length > 0) throw new Error(`scripted_telemetry_transport:unconsumed:${String(call)}:${q.length}`);
      }
    },
  });
}

export interface TelemetryScenarioHarness {
  readonly adapter: TelemetryPort;
  readonly sampleEvents: readonly TelemetryEvent[];
  readIoCount(): number;
  readSentPayloads(): readonly unknown[];
  readFaultLog?(): object;
}

export interface TelemetryFullCertificationScenarios {
  readonly http5xx: () => TelemetryScenarioHarness;
  readonly httpAuthFailure: () => TelemetryScenarioHarness;
  readonly rateLimited429: () => TelemetryScenarioHarness;
  readonly timeout: () => TelemetryScenarioHarness;
  readonly transportError: () => TelemetryScenarioHarness;
}

export interface TelemetryAdapterTestSubject {
  readonly id: string;
  readonly happyFlush: () => TelemetryScenarioHarness;
  readonly disabledPort: () => TelemetryScenarioHarness;
  readonly sensitiveValues?: readonly string[];
  readonly certification?: TelemetryFullCertificationScenarios;
}

export interface TelemetryQualification {
  readonly subjectId: string;
  readonly providerKind: string;
  readonly mode: "baseline" | "full";
  readonly capabilityDigest: string;
  readonly ledger: readonly {
    readonly scenario: string;
    readonly role: "happy" | "zero-io-disabled" | "redaction" | "transport-fault";
    readonly ioDelta: number;
    readonly faultLogDelta: number | null;
  }[];
}

export interface TelemetryConformanceEvidence {
  readonly contractVersion: typeof TELEMETRY_CONTRACT_VERSION;
  readonly mode: "baseline" | "full";
  readonly qualifications: readonly TelemetryQualification[];
}

function fail(code: string, message: string, location: string): never {
  throw new Error(`TELEMETRY_CONFORMANCE:${code}. ${message} Location: ${location}`);
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
          fail("secret_leak", "Sensitive canary leaked into telemetry payload or flush result.", location);
        }
      }
      return;
    }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer)) {
      walk(new TextDecoder().decode(new Uint8Array(v)));
      return;
    }
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      walk(new TextDecoder().decode(bytes));
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

function snapCaps(adapter: TelemetryPort, location: string): { caps: TelemetryCapabilities; digest: string } {
  rejectProxy(adapter, location);
  rejectProxy(adapter.capabilities, location);
  const parsed = telemetryCapabilitiesSchema.safeParse(adapter.capabilities);
  if (!parsed.success) fail("invalid_capabilities", parsed.error.issues[0]?.message ?? "invalid", location);
  const digest = createHash("sha256").update(JSON.stringify(projectTelemetryStaticCapabilities(parsed.data))).digest("hex");
  return { caps: parsed.data, digest };
}

async function flushChecked(
  harness: TelemetryScenarioHarness,
  events: readonly TelemetryEvent[],
  caps: TelemetryCapabilities,
  digest: string,
  sensitive: readonly string[] | undefined,
  location: string,
): Promise<{
  result: TelemetryFlushResult;
  ioDelta: number;
  payloadDelta: number;
  addedFaults: readonly RecordedTelemetryFault[];
  faultLogDelta: number | null;
}> {
  rejectProxy(harness, location);
  rejectProxy(harness.adapter.record, location);
  rejectProxy(harness.adapter.flush, location);
  rejectProxy(harness.readSentPayloads, location);
  const h = snapCaps(harness.adapter, location);
  if (h.caps.providerKind !== caps.providerKind || h.digest !== digest) {
    fail("capability_drift", "Harness capabilities drifted from certified capabilities.", location);
  }
  const ioBefore = harness.readIoCount();
  if (!Number.isSafeInteger(ioBefore) || ioBefore < 0) {
    fail("invalid_io_count", "readIoCount() must return a non-negative safe integer.", location);
  }
  const payloadsBeforeRaw = harness.readSentPayloads();
  rejectProxy(payloadsBeforeRaw, location);
  if (!Array.isArray(payloadsBeforeRaw)) {
    fail("invalid_sent_payloads", "readSentPayloads() must return an array.", location);
  }
  const payloadsBefore = payloadsBeforeRaw.length;
  const faultHandle = harness.readFaultLog ? harness.readFaultLog() : null;
  const faultBefore = faultHandle ? readFaultLog(faultHandle).length : null;
  for (const ev of events) {
    try {
      harness.adapter.record(ev);
    } catch {
      fail("record_threw", "record() must be fail-open and never throw.", location);
    }
  }
  let raw: unknown;
  try {
    raw = await harness.adapter.flush();
  } catch {
    fail("flush_threw", "flush() must be fail-open and never throw.", location);
  }
  rejectProxy(raw, location);
  const sentPayloads = harness.readSentPayloads();
  rejectProxy(sentPayloads, location);
  if (!Array.isArray(sentPayloads)) {
    fail("invalid_sent_payloads", "readSentPayloads() must return an array.", location);
  }
  assertNoLeak(raw, sensitive, location);
  assertNoLeak(sentPayloads, sensitive, location);
  const parsed = telemetryFlushResultSchema.safeParse(raw);
  if (!parsed.success) fail("invalid_result_shape", parsed.error.issues[0]?.message ?? "invalid", location);
  const ioAfter = harness.readIoCount();
  if (!Number.isSafeInteger(ioAfter) || ioAfter < ioBefore) {
    fail("invalid_io_count", "readIoCount() must be non-decreasing safe integer.", location);
  }
  const ioDelta = ioAfter - ioBefore;
  const payloadDelta = sentPayloads.length - payloadsBefore;
  if (!Number.isSafeInteger(payloadDelta) || payloadDelta < 0) {
    fail("invalid_sent_payloads", "readSentPayloads() length must be non-decreasing.", location);
  }
  const addedFaults = faultHandle && faultBefore !== null ? readFaultLog(faultHandle).slice(faultBefore) : [];
  return {
    result: parsed.data,
    ioDelta,
    payloadDelta,
    addedFaults,
    faultLogDelta: faultHandle && faultBefore !== null ? addedFaults.length : null,
  };
}

export async function runTelemetryAdapterConformance(
  subjects: readonly TelemetryAdapterTestSubject[],
  options?: { readonly mode?: "baseline" | "full" },
): Promise<TelemetryConformanceEvidence> {
  rejectProxy(subjects, "subjects");
  if (!Array.isArray(subjects) || subjects.length === 0) fail("empty_subjects", "Supply at least one subject.", "subjects");
  const mode = options?.mode ?? "baseline";
  const qualifications: TelemetryQualification[] = [];

  for (const subject of subjects) {
    rejectProxy(subject, `subject:${subject?.id ?? "unknown"}`);
    if (!subject.id || !subject.id.trim()) fail("invalid_subject_id", "Provide non-empty subject.id.", "subject");
    const loc = (s: string) => `${subject.id}:${s}`;
    const ledger: TelemetryQualification["ledger"][number][] = [];

    // 1. Happy batch flush
    const happyH = subject.happyFlush();
    const { caps, digest } = snapCaps(happyH.adapter, loc("capabilities"));
    const happy = await flushChecked(happyH, happyH.sampleEvents, caps, digest, subject.sensitiveValues, loc("happyFlush"));
    if (happy.result.kind !== "flushed" || happy.result.accepted < 1 || happy.ioDelta !== 1 || happy.payloadDelta < 1) {
      fail("happy_flush_failed", `Expected flushed(accepted>=1) with ioDelta=1 and captured sent payload, got ${happy.result.kind} (io=${happy.ioDelta}, payloads=${happy.payloadDelta}).`, loc("happyFlush"));
    }
    ledger.push({ scenario: "happyFlush", role: "happy", ioDelta: happy.ioDelta, faultLogDelta: happy.faultLogDelta });

    // 2. Empty flush noop at 0 I/O
    const emptyOut = await flushChecked(happyH, [], caps, digest, subject.sensitiveValues, loc("emptyFlush"));
    if (emptyOut.result.kind !== "noop" || emptyOut.ioDelta !== 0) {
      fail("empty_flush_not_noop", "Flushing an empty queue must return noop with ioDelta=0.", loc("emptyFlush"));
    }
    ledger.push({ scenario: "emptyFlush", role: "zero-io-disabled", ioDelta: 0, faultLogDelta: emptyOut.faultLogDelta });

    // 3. Disabled zero-I/O check
    const disabledH = subject.disabledPort();
    const disabledOut = await flushChecked(disabledH, disabledH.sampleEvents, caps, digest, subject.sensitiveValues, loc("disabledPort"));
    if (disabledOut.result.kind !== "noop" || disabledOut.ioDelta !== 0) {
      fail("disabled_port_io", "Disabled telemetry port must perform 0 I/O and return noop.", loc("disabledPort"));
    }
    ledger.push({ scenario: "disabledPort", role: "zero-io-disabled", ioDelta: 0, faultLogDelta: disabledOut.faultLogDelta });

    // 4. Mandatory secret/PII redaction probe on outbound payloads
    const piiCanary = "buyer-canary@example.invalid";
    const secretCanary = "Bearer telemetry-canary-token-999";
    const redactionH = subject.happyFlush();
    const redactionEvent: TelemetryEvent = {
      kind: "log",
      severity: "info",
      message: `Checkout event for ${piiCanary} using ${secretCanary}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      attributes: {
        authorization: secretCanary,
        customer_email: piiCanary,
        safe_key: "ok",
      },
    };
    const redactionOut = await flushChecked(
      redactionH,
      [redactionEvent],
      caps,
      digest,
      [...(subject.sensitiveValues ?? []), piiCanary, "telemetry-canary-token-999"],
      loc("pii_redaction"),
    );
    if (redactionOut.result.kind !== "flushed" || redactionOut.result.accepted < 1 || redactionOut.ioDelta !== 1 || redactionOut.payloadDelta < 1) {
      fail("redaction_flush_failed", "Redaction probe expected flushed(accepted>=1) with ioDelta=1 and at least 1 captured outbound payload.", loc("pii_redaction"));
    }
    ledger.push({ scenario: "pii_redaction", role: "redaction", ioDelta: redactionOut.ioDelta, faultLogDelta: redactionOut.faultLogDelta });

    // 5. Full-mode fail-open fault certification
    if (mode === "full") {
      if (!subject.certification) fail("missing_certification_scenarios", "mode: 'full' requires subject.certification.", loc("certification"));
      rejectProxy(subject.certification, loc("certification"));
      const specs = [
        { name: "http-5xx", factory: subject.certification.http5xx, retryable: true, check: (f: RecordedTelemetryFault) => f.kind === "http-failure" && (f.status ?? 0) >= 500 },
        { name: "http-auth-failure", factory: subject.certification.httpAuthFailure, retryable: false, check: (f: RecordedTelemetryFault) => f.kind === "http-failure" && (f.status === 401 || f.status === 403) },
        { name: "rate-limited-429", factory: subject.certification.rateLimited429, retryable: true, check: (f: RecordedTelemetryFault) => f.kind === "rate-limited-429" },
        { name: "timeout", factory: subject.certification.timeout, retryable: true, check: (f: RecordedTelemetryFault) => f.kind === "timeout" },
        { name: "transport-error", factory: subject.certification.transportError, retryable: true, check: (f: RecordedTelemetryFault) => f.kind === "transport-error" },
      ];
      for (const spec of specs) {
        const h = spec.factory();
        if (!h.readFaultLog) fail("missing_fault_log_handle", "mode: 'full' requires readFaultLog().", loc(spec.name));
        const out = await flushChecked(h, h.sampleEvents, caps, digest, subject.sensitiveValues, loc(spec.name));
        if (out.ioDelta !== 1 || out.addedFaults.length !== 1 || !spec.check(out.addedFaults[0]!)) {
          fail("fault_kind_mismatch", `Expected authenticated fault on ${spec.name} with ioDelta=1.`, loc(spec.name));
        }
        if (out.result.kind !== "failed" || out.result.retryable !== spec.retryable || out.result.accepted !== 0) {
          fail("fault_result_mismatch", `Expected fail-open failed(retryable=${spec.retryable}) on ${spec.name}.`, loc(spec.name));
        }
        ledger.push({ scenario: spec.name, role: "transport-fault", ioDelta: out.ioDelta, faultLogDelta: out.faultLogDelta });
      }
    }

    qualifications.push({ subjectId: subject.id, providerKind: caps.providerKind, mode, capabilityDigest: digest, ledger });
  }

  return { contractVersion: TELEMETRY_CONTRACT_VERSION, mode, qualifications };
}
