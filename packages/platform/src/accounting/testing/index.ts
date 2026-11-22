import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import {
  ACCOUNTING_EXPORT_CONTRACT_VERSION,
  accountingCapabilitiesSchema,
  accountingExportResultSchema,
  accountingReadbackResultSchema,
  projectAccountingStaticCapabilities,
  type AccountingCapabilities,
  type AccountingExportRecord,
  type AccountingExportResult,
  type AccountingLedgerExportPort,
} from "../index.js";

/** @experimental Offline accounting ledger-export conformance runner and scripted transport fake. */

export type ScriptedAccountingOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "http-failure"; readonly status: number; readonly response?: T }
  | { readonly kind: "rate-limited-429"; readonly retryAfterSeconds?: number; readonly response?: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport-error" };

export class ScriptedAccountingTransportError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly kind: Exclude<ScriptedAccountingOutcome<never>["kind"], "success">,
    options?: { readonly status?: number; readonly retryAfterSeconds?: number },
  ) {
    super(`scripted_accounting_transport:${kind}`);
    this.name = kind === "timeout" ? "AbortError" : "ScriptedAccountingTransportError";
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

interface RecordedAccountingFault {
  readonly kind: ScriptedAccountingOutcome<unknown>["kind"] | "unscripted";
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

const faultLogs = new WeakMap<object, readonly RecordedAccountingFault[]>();

function readFaultLog(handle: object): readonly RecordedAccountingFault[] {
  const log = faultLogs.get(handle);
  if (!log) throw new Error("ACCOUNTING_CONFORMANCE:invalid_fault_log");
  return log.map((r) => ({ ...r }));
}

export interface ScriptedAccountingFake<Calls extends Record<string, unknown>> {
  readonly calls: readonly { readonly call: keyof Calls; readonly kind: ScriptedAccountingOutcome<unknown>["kind"] | "unscripted" }[];
  enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedAccountingOutcome<Calls[K]>[]): void;
  invoke<K extends keyof Calls>(call: K): Promise<Calls[K]>;
  assertDrained(): void;
}

export function createScriptedAccountingFake<Calls extends Record<string, unknown>>(): ScriptedAccountingFake<Calls> {
  const queues = new Map<keyof Calls, ScriptedAccountingOutcome<Calls[keyof Calls]>[]>();
  const calls: { call: keyof Calls; kind: ScriptedAccountingOutcome<unknown>["kind"] | "unscripted" }[] = [];
  const faults: RecordedAccountingFault[] = [];
  return Object.freeze({
    get calls() {
      const snap = Object.freeze(calls.map((r) => Object.freeze({ ...r })));
      faultLogs.set(snap, faults);
      return snap;
    },
    enqueue<K extends keyof Calls>(call: K, ...outcomes: ScriptedAccountingOutcome<Calls[K]>[]): void {
      const parsed = outcomes.map((o) => outcomeSchema.parse(o) as ScriptedAccountingOutcome<Calls[K]>);
      const q = queues.get(call) ?? [];
      q.push(...parsed);
      queues.set(call, q);
    },
    async invoke<K extends keyof Calls>(call: K): Promise<Calls[K]> {
      const outcome = queues.get(call)?.shift();
      if (!outcome) {
        calls.push({ call, kind: "unscripted" });
        faults.push({ kind: "unscripted" });
        throw new Error(`scripted_accounting_transport:unscripted:${String(call)}`);
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
      if ((outcome.kind === "http-failure" || outcome.kind === "rate-limited-429") && outcome.response !== undefined) {
        return outcome.response as Calls[K];
      }
      throw new ScriptedAccountingTransportError(outcome.kind, {
        ...(outcome.kind === "http-failure" ? { status: outcome.status } : {}),
        ...(outcome.kind === "rate-limited-429" && outcome.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: outcome.retryAfterSeconds }
          : {}),
      });
    },
    assertDrained(): void {
      for (const [call, q] of queues) {
        if (q.length > 0) throw new Error(`scripted_accounting_transport:unconsumed:${String(call)}:${q.length}`);
      }
    },
  });
}

export interface AccountingScenarioHarness {
  readonly adapter: AccountingLedgerExportPort;
  readonly record: AccountingExportRecord;
  readIoCount(): number;
  readFaultLog?(): object;
}

export interface AccountingFullCertificationScenarios {
  readonly http5xx: () => AccountingScenarioHarness;
  readonly httpAuthFailure: () => AccountingScenarioHarness;
  readonly httpConflict409: () => AccountingScenarioHarness;
  readonly rateLimited429: () => AccountingScenarioHarness;
  readonly timeout: () => AccountingScenarioHarness;
  readonly readbackFound?: () => AccountingScenarioHarness;
}

export interface AccountingAdapterTestSubject {
  readonly id: string;
  readonly happyExport: () => AccountingScenarioHarness;
  readonly sensitiveValues?: readonly string[];
  readonly certification?: AccountingFullCertificationScenarios;
}

export interface AccountingQualification {
  readonly subjectId: string;
  readonly providerKind: string;
  readonly mode: "baseline" | "full";
  readonly capabilityDigest: string;
  readonly ledger: readonly {
    readonly scenario: string;
    readonly role: "happy" | "zero-io-refusal" | "transport-fault" | "readback";
    readonly ioDelta: number;
    readonly faultLogDelta: number | null;
  }[];
}

export interface AccountingConformanceEvidence {
  readonly contractVersion: typeof ACCOUNTING_EXPORT_CONTRACT_VERSION;
  readonly mode: "baseline" | "full";
  readonly qualifications: readonly AccountingQualification[];
}

function fail(code: string, message: string, location: string): never {
  throw new Error(`ACCOUNTING_CONFORMANCE:${code}. ${message} Location: ${location}`);
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
          fail("secret_leak", "Sensitive canary leaked into accounting adapter output or error.", location);
        }
      }
      return;
    }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const i of v) walk(i); return; }
    if (v instanceof Error) { walk(v.name); walk(v.message); walk(v.stack); if ("cause" in v) walk((v as Error & { cause?: unknown }).cause); }
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k === "string") walk(k);
      let prop: unknown;
      try { prop = Reflect.get(v, k); } catch { continue; }
      walk(prop);
    }
  };
  walk(payload);
}

function snapCaps(adapter: AccountingLedgerExportPort, location: string): { caps: AccountingCapabilities; digest: string } {
  rejectProxy(adapter, location);
  rejectProxy(adapter.exportEntry, location);
  rejectProxy(adapter.capabilities, location);
  const parsed = accountingCapabilitiesSchema.safeParse(adapter.capabilities);
  if (!parsed.success) fail("invalid_capabilities", parsed.error.issues[0]?.message ?? "invalid", location);
  const digest = createHash("sha256").update(JSON.stringify(projectAccountingStaticCapabilities(parsed.data))).digest("hex");
  return { caps: parsed.data, digest };
}

async function runExport(
  harness: AccountingScenarioHarness,
  record: AccountingExportRecord,
  caps: AccountingCapabilities,
  digest: string,
  sensitive: readonly string[] | undefined,
  location: string,
): Promise<{ result: AccountingExportResult; ioDelta: number; addedFaults: readonly RecordedAccountingFault[]; faultLogDelta: number | null }> {
  rejectProxy(harness, location);
  const h = snapCaps(harness.adapter, location);
  if (h.caps.providerKind !== caps.providerKind || h.digest !== digest) {
    fail("capability_drift", "Scenario harness capabilities differ from certified capabilities.", location);
  }
  const ioBefore = harness.readIoCount();
  if (!Number.isSafeInteger(ioBefore) || ioBefore < 0) fail("invalid_io_count", "readIoCount must be non-negative safe integer.", location);
  const faultHandle = harness.readFaultLog ? harness.readFaultLog() : null;
  const faultBefore = faultHandle ? readFaultLog(faultHandle).length : null;

  let raw: unknown;
  try {
    raw = await harness.adapter.exportEntry(record);
  } catch (err) {
    assertNoLeak(err, sensitive, location);
    fail("uncaught_throw", "exportEntry() must return a structured AccountingExportResult instead of throwing.", location);
  }
  rejectProxy(raw, location);
  assertNoLeak(raw, sensitive, location);
  const parsed = accountingExportResultSchema.safeParse(raw);
  if (!parsed.success) fail("invalid_result_shape", parsed.error.issues[0]?.message ?? "invalid", location);
  if (parsed.data.providerKind !== caps.providerKind) fail("provider_kind_mismatch", "Result providerKind mismatch.", location);

  const ioDelta = harness.readIoCount() - ioBefore;
  if (!Number.isSafeInteger(ioDelta) || ioDelta < 0) fail("invalid_io_count", "readIoCount decreased.", location);
  const addedFaults = faultHandle && faultBefore !== null ? readFaultLog(faultHandle).slice(faultBefore) : [];
  return { result: parsed.data, ioDelta, addedFaults, faultLogDelta: faultHandle && faultBefore !== null ? addedFaults.length : null };
}

export async function runAccountingAdapterConformance(
  subjects: readonly AccountingAdapterTestSubject[],
  options?: { readonly mode?: "baseline" | "full" },
): Promise<AccountingConformanceEvidence> {
  rejectProxy(subjects, "subjects");
  if (!Array.isArray(subjects) || subjects.length === 0) fail("empty_subjects", "Supply at least one subject.", "subjects");
  const mode = options?.mode ?? "baseline";
  const qualifications: AccountingQualification[] = [];

  for (const subject of subjects) {
    rejectProxy(subject, `subject:${subject?.id ?? "unknown"}`);
    if (!subject.id || !subject.id.trim()) fail("invalid_subject_id", "Provide non-empty subject.id.", "subject");
    assertNoLeak(subject.id, subject.sensitiveValues, subject.id);
    const loc = (s: string) => `${subject.id}:${s}`;
    const ledger: AccountingQualification["ledger"][number][] = [];

    const happyH = subject.happyExport();
    const { caps, digest } = snapCaps(happyH.adapter, loc("capabilities"));
    const happy = await runExport(happyH, happyH.record, caps, digest, subject.sensitiveValues, loc("happyExport"));
    if (happy.result.kind !== "exported" || happy.ioDelta !== 1 || happy.result.exportKey !== happyH.record.exportKey) {
      fail("happy_export_failed", `Expected exported with matching exportKey and ioDelta=1, got ${happy.result.kind} (io=${happy.ioDelta}).`, loc("happyExport"));
    }
    ledger.push({ scenario: "happyExport", role: "happy", ioDelta: happy.ioDelta, faultLogDelta: happy.faultLogDelta });

    // Zero-I/O refusals on fresh harnesses
    const baseRec = happyH.record;
    const probes: readonly { name: string; record: AccountingExportRecord; reason: string }[] = [
      {
        name: "unbalanced_journal",
        record: { ...baseRec, exportKey: `${baseRec.exportKey}::unbalanced`, lines: [{ accountCode: "1000", side: "debit", amountMinor: 500 }, { accountCode: "4000", side: "credit", amountMinor: 400 }] },
        reason: "unbalanced_entry",
      },
      {
        name: "missing_account_code",
        record: { ...baseRec, exportKey: `${baseRec.exportKey}::missing-acct`, lines: [{ accountCode: "   ", side: "debit", amountMinor: 500 }, { accountCode: "4000", side: "credit", amountMinor: 500 }] },
        reason: "missing_account_mapping",
      },
      {
        name: "invalid_date",
        record: { ...baseRec, exportKey: `${baseRec.exportKey}::bad-date`, entryDate: "2026-02-30" },
        reason: "invalid_record",
      },
    ];
    for (const p of probes) {
      const h = subject.happyExport();
      const out = await runExport(h, p.record, caps, digest, subject.sensitiveValues, loc(p.name));
      if (out.ioDelta !== 0 || out.result.kind !== "refused" || out.result.reason !== p.reason) {
        fail("zero_io_refusal_failed", `Expected zero-I/O refused(${p.reason}) on ${p.name}, got ${out.result.kind} (io=${out.ioDelta}).`, loc(p.name));
      }
      ledger.push({ scenario: p.name, role: "zero-io-refusal", ioDelta: out.ioDelta, faultLogDelta: out.faultLogDelta });
    }

    if (mode === "full") {
      if (!subject.certification) fail("missing_certification_scenarios", "mode: 'full' requires subject.certification.", loc("certification"));
      rejectProxy(subject.certification, loc("certification"));
      const faultSpecs = [
        { name: "http-5xx", factory: subject.certification.http5xx, expectKind: "unknown" as const, checkFault: (f: RecordedAccountingFault) => f.kind === "http-failure" && (f.status ?? 0) >= 500, checkRes: (r: AccountingExportResult) => r.kind === "unknown" && r.reason === "provider_unavailable" },
        { name: "http-auth-failure", factory: subject.certification.httpAuthFailure, expectKind: "refused" as const, checkFault: (f: RecordedAccountingFault) => f.kind === "http-failure" && (f.status === 401 || f.status === 403), checkRes: (r: AccountingExportResult) => r.kind === "refused" && r.reason === "authentication_failed" },
        { name: "http-conflict-409", factory: subject.certification.httpConflict409, expectKind: "unknown" as const, checkFault: (f: RecordedAccountingFault) => f.kind === "http-failure" && (f.status === 408 || f.status === 409), checkRes: (r: AccountingExportResult) => r.kind === "unknown" && r.reason === "ambiguous_conflict" },
        { name: "rate-limited-429", factory: subject.certification.rateLimited429, expectKind: "unknown" as const, checkFault: (f: RecordedAccountingFault) => f.kind === "rate-limited-429" && f.retryAfterSeconds !== undefined, checkRes: (r: AccountingExportResult, f: RecordedAccountingFault) => r.kind === "unknown" && r.reason === "rate_limited" && r.retryAfterSeconds === f.retryAfterSeconds },
        { name: "timeout", factory: subject.certification.timeout, expectKind: "unknown" as const, checkFault: (f: RecordedAccountingFault) => f.kind === "timeout", checkRes: (r: AccountingExportResult) => r.kind === "unknown" && r.reason === "timeout" },
      ];
      for (const spec of faultSpecs) {
        const h = spec.factory();
        if (!h.readFaultLog) fail("missing_fault_log_handle", "mode: 'full' requires readFaultLog().", loc(spec.name));
        const out = await runExport(h, h.record, caps, digest, subject.sensitiveValues, loc(spec.name));
        if (out.ioDelta !== 1 || out.addedFaults.length !== 1) {
          fail("fault_io_mismatch", `Expected ioDelta=1 and faultLogDelta=1 on ${spec.name}.`, loc(spec.name));
        }
        const fault = out.addedFaults[0]!;
        if (!spec.checkFault(fault)) fail("fault_kind_mismatch", `Injected fault on ${spec.name} did not match required fault kind/status.`, loc(spec.name));
        if (!spec.checkRes(out.result, fault)) {
          fail("fault_result_mismatch", `Result on ${spec.name} failed uncertainty/refusal contract (expected ${spec.expectKind}).`, loc(spec.name));
        }
        ledger.push({ scenario: spec.name, role: "transport-fault", ioDelta: out.ioDelta, faultLogDelta: out.faultLogDelta });
      }

      if (caps.supportsReadback) {
        if (!subject.certification.readbackFound) {
          fail("missing_readback_harness", "supportsReadback: true requires certification.readbackFound.", loc("readbackFound"));
        }
        const rbH = subject.certification.readbackFound();
        rejectProxy(rbH, loc("readbackFound"));
        const rbCaps = snapCaps(rbH.adapter, loc("readbackFound"));
        if (rbCaps.caps.providerKind !== caps.providerKind || rbCaps.digest !== digest) {
          fail("capability_drift", "readbackFound harness capabilities differ from certified capabilities.", loc("readbackFound"));
        }
        if (!rbH.adapter.readEntryByKey) fail("missing_readback_method", "Adapter declares supportsReadback: true without readEntryByKey().", loc("readbackFound"));
        rejectProxy(rbH.adapter.readEntryByKey, loc("readbackFound"));
        if (!rbH.readFaultLog) fail("missing_fault_log_handle", "mode: 'full' requires readFaultLog() on readbackFound.", loc("readbackFound"));
        const ioBefore = rbH.readIoCount();
        if (!Number.isSafeInteger(ioBefore) || ioBefore < 0) fail("invalid_io_count", "readIoCount must be non-negative safe integer.", loc("readbackFound"));
        const rbFaultHandle = rbH.readFaultLog();
        const rbFaultBefore = readFaultLog(rbFaultHandle).length;
        let rbRaw: unknown;
        try {
          rbRaw = await rbH.adapter.readEntryByKey(rbH.record.exportKey);
        } catch (err) {
          assertNoLeak(err, subject.sensitiveValues, loc("readbackFound"));
          fail("uncaught_throw", "readEntryByKey() must return a structured AccountingReadbackResult instead of throwing.", loc("readbackFound"));
        }
        rejectProxy(rbRaw, loc("readbackFound"));
        assertNoLeak(rbRaw, subject.sensitiveValues, loc("readbackFound"));
        const rbParsed = accountingReadbackResultSchema.safeParse(rbRaw);
        const ioAfter = rbH.readIoCount();
        const rbAddedFaults = readFaultLog(rbFaultHandle).slice(rbFaultBefore);
        const rbFaultDelta = rbAddedFaults.length;
        if (
          !rbParsed.success ||
          rbParsed.data.kind !== "found" ||
          rbParsed.data.providerKind !== caps.providerKind ||
          rbParsed.data.exportKey !== rbH.record.exportKey ||
          !Number.isSafeInteger(ioAfter) ||
          ioAfter - ioBefore !== 1 ||
          rbFaultDelta !== 1 ||
          rbAddedFaults[0]?.kind !== "success"
        ) {
          fail("readback_failed", "readEntryByKey must return valid found result matching providerKind/exportKey with ioDelta=1 and 1 authenticated success fault-log entry.", loc("readbackFound"));
        }
        ledger.push({ scenario: "readbackFound", role: "readback", ioDelta: 1, faultLogDelta: rbFaultDelta });
      }
    }

    qualifications.push({ subjectId: subject.id, providerKind: caps.providerKind, mode, capabilityDigest: digest, ledger });
  }

  return { contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION, mode, qualifications };
}
