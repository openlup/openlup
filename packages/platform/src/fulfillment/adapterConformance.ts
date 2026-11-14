import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { z } from "zod";
import type { FulfillmentAdapterConformanceEvidence, FulfillmentAdapterConformanceSubject, FulfillmentCapabilityDescriptor, FulfillmentRefusal } from "./contracts/index.js";
import type { FulfillmentAdapterTestSubject, FulfillmentConformanceOptions, FulfillmentQualification } from "./testing/scenarios.js";
import { dispatchEvidence, dispatchResult } from "./dispatchProjection.js";
import { projectObservation } from "./observationProjection.js";
import { isCapturedFulfillmentAdapter } from "./capturedAdapter.js";
import { readFulfillmentCapabilities } from "./providerCapabilities.js";
import { runFulfillmentDispatchWorker } from "./providerDispatchWorker.js";
import { runFulfillmentStockSyncWorker } from "./providerStockSyncWorker.js";
import { readScriptedFulfillmentFaultLog } from "./testing/scriptedFake.js";
import { PORTLESS_CAPABILITIES, subjectSchema, snapshot, freeze, results, refusal, requireFact, type Operation } from "./testing/schema.js";

type Subject = FulfillmentAdapterConformanceSubject & Pick<FulfillmentAdapterTestSubject, "adapter" | "certification">;
type Capability = keyof FulfillmentCapabilityDescriptor["operations"];
type Entry = FulfillmentQualification["ledger"][number] & { kind: string; value: unknown; input: unknown[]; replay?: boolean };
type Slot = { op: Operation; input: unknown[]; capability: string; slotId: string; label: string; zero?: string; replay?: boolean; faults?: object; positive?: boolean } & ({ expected: unknown; throws?: never } | { throws: FulfillmentRefusal; expected?: never });
const same = (actual: unknown, expected: unknown, label: string) => requireFact(isDeepStrictEqual(actual, expected), label);
const unsupported = (phase: FulfillmentRefusal["phase"]): FulfillmentRefusal => ({ reason: "unsupported", phase, retryable: false });
const transportNames = ["transport-before-submission", "transport-after-submission", "http-failure"] as const;
/** Snapshot data once; only executed, independently compared invocations can enter the evidence ledger. */
export async function runFulfillmentAdapterConformance(subjects: readonly Subject[], options: FulfillmentConformanceOptions = { mode: "baseline" }): Promise<FulfillmentAdapterConformanceEvidence & { mode: "baseline" | "full"; qualifications: readonly FulfillmentQualification[] }> {
  const mode = z.strictObject({ mode: z.enum(["baseline", "full"]) }).parse(snapshot(options)).mode;
  requireFact(Array.isArray(subjects) && !types.isProxy(subjects) && subjects.length > 0, "full subjects required: nonempty array");
  requireFact(Reflect.ownKeys(subjects).every(key => typeof key === "string" && (key === "length" || /^(0|[1-9][0-9]*)$/.test(key)) && !Object.getOwnPropertyDescriptor(subjects, key)?.get), "validation:subjects");
  const subjectList = Array.from({ length: subjects.length }, (_, index) => subjects[index]!);
  const preparedSubjects = subjectList.map((subject: Subject) => {
    requireFact(!types.isProxy(subject), "validation:subject_proxy");
    const adapter = subject.adapter, certification = subject.certification;
    const data = { subjectId: subject.subjectId, capabilities: adapter.capabilities, sensitiveValues: subject.sensitiveValues, fixtures: subject.fixtures, ...(certification ? { certification } : {}) };
    const frozen = snapshot(data), checked = subjectSchema.safeParse(frozen);
    requireFact(checked.success, `validation:fixtures ${checked.success ? "" : checked.error.message}`);
    const dispatch = adapter.dispatch, prepare = dispatch.prepare, submit = dispatch.dispatch;
    const profile: "adapter" | "dispatch-only" = isCapturedFulfillmentAdapter(adapter, dispatch, prepare, submit) ? "dispatch-only" : "adapter";
    requireFact(!certification?.profile || frozen.certification?.profile === profile, "capability_not_certifiable:dispatch-only brand");
    const ports: Partial<Record<Operation, (...args: unknown[]) => Promise<unknown>>> = {};
    for (const [op, port, method] of [["prepare", adapter.dispatch, "prepare"], ["dispatch", adapter.dispatch, "dispatch"], ["create", adapter.label, "create"], ["read", adapter.label, "read"], ["void", adapter.label, "void"], ["observation", adapter.observation, "verifyAndNormalize"], ["readback", adapter.readback, "read"], ["page", adapter.reconciliation, "readPage"], ...["getStock", "getStockMovements"].map(op => [op, adapter.stockSync, op] as const), ...["ensureProduct", "getProductPacks", "addProductPack", "listStockedSkus"].map(op => [op, adapter.productSync, op] as const)] as const) {
      const methodValue = (op === "prepare" ? prepare : op === "dispatch" ? submit : port && (port as unknown as Record<string, unknown>)[method]) as ((...args: unknown[]) => Promise<unknown>) | undefined;
      if (methodValue) ports[op as Operation] = methodValue.bind(port);
    }
    const logs = new Map<number, object>();
    for (const name of transportNames) { const scenario = certification?.dispatch?.transport[name]; if (scenario) { readScriptedFulfillmentFaultLog(scenario.calls); logs.set(scenario.fixture, scenario.calls); } }
    if (mode === "full") validateFull(frozen, profile);
    return { subject: { ...subject, observationCodecs: subject.observationCodecs ? { ...subject.observationCodecs } : undefined, ...freeze(frozen), adapter: { ...adapter, capabilities: frozen.capabilities } }, ports, profile, logs, count: subject.readIoCount.bind(subject) };
  });
  const evidence: FulfillmentAdapterConformanceEvidence["subjects"][number][] = [], cases: FulfillmentAdapterConformanceEvidence["cases"][number][] = [], qualifications: FulfillmentQualification[] = [];
  for (const { subject, ports, profile, logs, count } of preparedSubjects) {
    const { fixtures, certification: kit } = subject, caps = subject.adapter.capabilities, ledger: Entry[] = [];
    const passed = (operation: string) => cases.push({ subjectId: subject.subjectId, operation, passed: true });
    const io = () => { const value = count(); requireFact(Number.isSafeInteger(value) && value >= 0, "validation:io_count"); return value; };
    // This is the ONLY credit site. Arguments, methods and expectations are resolved outside the call's try block.
    const witness = async <O extends Operation>(slot: Slot & { op: O }): Promise<z.output<(typeof results)[O]>> => {
      const method = ports[slot.op]; requireFact(method, `${slot.label} port required`);
      const input = snapshot(slot.input), before = io(), faultsBefore = slot.faults ? readScriptedFulfillmentFaultLog(slot.faults).length : 0;
      let returned = true, raw: unknown;
      try { raw = await method(...input); } catch (error) { returned = false; raw = error; }
      const value = snapshot(raw), ioDelta = io() - before, faultLogDelta = slot.faults ? readScriptedFulfillmentFaultLog(slot.faults).slice(faultsBefore) : [];
      requireFact(ioDelta >= 0, "validation:io_count_regressed");
      const expectedThrow = Object.hasOwn(slot, "throws");
      requireFact(returned !== expectedThrow, `${slot.label} ${expectedThrow ? "failure did not throw" : "success did not return"}`);
      let actual: unknown, expected: unknown;
      if (expectedThrow) {
        const thrown = refusal.extend({ providerFailure: z.boolean().optional(), status: z.number().int().nullable().optional(), code: z.string().nullable().optional(), providerError: z.strictObject({ operation: z.enum(["get_stock", "get_stock_movements"]), status: z.number().int().nullable(), code: z.string(), retryable: z.boolean() }).optional() }).safeParse(value);
        requireFact(thrown.success, `${slot.label} contradictory result: typed failure required`);
        actual = { reason: thrown.data.reason, phase: thrown.data.phase, retryable: thrown.data.retryable }; expected = slot.throws;
      } else {
        const checked = results[slot.op].safeParse(value), expectedChecked = results[slot.op].safeParse(slot.expected);
        requireFact(checked.success && expectedChecked.success, `${slot.label} contradictory result: validation`);
        actual = value; expected = slot.expected;
      }
      const classify = (value: unknown): { kind: string; role: Entry["role"] } => {
        if (expectedThrow) return { kind: "refused", role: "failure" };
        if (slot.op === "void") return { kind: (value as { canProceed: boolean }).canProceed ? "voided" : "refused", role: (value as { canProceed: boolean }).canProceed ? "success" : "failure" };
        if (slot.op === "addProductPack") return { kind: "written", role: "success" };
        if (slot.op === "ensureProduct") return { kind: value === null ? "skipped" : (value as { replayed: boolean }).replayed ? "replayed" : "created", role: value !== null && !(value as { replayed: boolean }).replayed ? "success" : "neutral" };
        if (Array.isArray(value)) { const positive = value.some(row => typeof row === "string" ? row.trim() : slot.op === "getProductPacks" ? row.ean.trim() && row.quantity > 0 : row.kind !== "rejected"); return { kind: positive ? "populated" : "empty", role: positive ? "success" : "neutral" }; }
        const record = value as { kind: string; rows?: { kind: string }[] }, kind = record.kind;
        return { kind, role: ["refused", "not_dispatched", "unknown", "unsupported", "failed"].includes(kind) ? "failure" : kind === "page" && !record.rows!.some(row => row.kind === "found" || row.kind === "absent") ? "neutral" : "success" };
      };
      const credit = classify(actual); requireFact(credit.kind === classify(expected).kind, `${slot.label} result kind mismatch`); same(actual, expected, slot.label);
      requireFact(!slot.positive || credit.role === "success", `${slot.label} positive success required`);
      const reason = expectedThrow ? (actual as FulfillmentRefusal).reason : (actual as { refusal?: FulfillmentRefusal } | null)?.refusal?.reason;
      const supported = caps.operations[slot.capability as Capability]?.supported;
      requireFact(!(mode === "full" && supported && credit.role === "failure" && reason === "unsupported"), `${slot.label} supported_failure_unsupported`);
      if (supported === false && slot.op !== "native" && !(mode === "baseline" && slot.op === "read" && caps.labelReadOwner === "host_storage" && credit.kind === "available")) requireFact(credit.role === "failure" && reason === "unsupported", `unsupported ${slot.capability} explicit refusal`);
      requireFact(!slot.zero || ioDelta === 0, slot.zero ?? "zero I/O");
      if (mode === "full" && reason === "untrusted") requireFact(ioDelta === 0, "authentication refusal before I/O");
      if (!(slot.op === "read" && credit.kind === "available")) assertDurable(actual, subject);
      if (slot.op === "prepare" && credit.kind === "prepared") { const value = actual as z.output<typeof results.prepare>;
        if (value.kind === "prepared") { same(value.evidence, dispatchEvidence(value.evidence), "prepared evidence allowlist"); same(value.evidence.contactRevision, (slot.input[0] as Subject["fixtures"]["dispatch"][number]["input"]).contactRevision, "prepared contact identity"); requireFact(value.evidence.providerRef === (slot.input[0] as Subject["fixtures"]["dispatch"][number]["input"]).selection.providerRef, "prepared provider identity"); }
      }
      if (slot.op === "dispatch") same(actual, dispatchResult(actual as Parameters<typeof dispatchResult>[0]), "dispatch allowlist");
      ledger.push({ capability: slot.capability, role: supported === false && credit.role === "failure" ? "refusal" : credit.role, slotId: slot.slotId, ioDelta, faultLogDelta, kind: credit.kind, value: actual, input: slot.input, replay: slot.replay });
      return actual as z.output<(typeof results)[O]>;
    };
    const first = fixtures.dispatch[0]!;
    await witness({ op: "prepare", capability: "selection", slotId: "selection", input: [{ ...first.input, selection: { ...first.input.selection, providerRef: null } }], expected: { kind: "refused", refusal: { reason: "selection_required", phase: "selection", retryable: false } }, zero: "selection refusal before I/O", label: "adapter selection_required" }); passed("default-off and selection_required");
    for (const [index, row] of fixtures.dispatch.entries()) {
      const prepared = await witness({ op: "prepare", capability: row.input.selection.deliveryKind === "parcel-locker" && row.expectedPrepare.kind === "refused" ? "pickupPoint" : "preparation", slotId: kit?.dispatch?.addressBeforeSubmission === index ? "prepare:addressBefore" : `prepare:${index}`, input: [row.input], expected: row.expectedPrepare, zero: "prepare before I/O", label: "prepare fixture" });
      if (prepared.kind === "refused") { passed("dispatch refused before I/O"); continue; }
      requireFact(caps.operations.dispatch.supported, "unsupported dispatch refuses");
      await witness({ op: "dispatch", capability: "mismatch", slotId: `mismatch:${index}`, input: [row.input, { ...prepared.evidence, commandFingerprint: `${prepared.evidence.commandFingerprint}:mismatch` }], expected: { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } }, zero: "mismatch before I/O", label: "mismatched preparation refusal" });
      const result = await witness({ op: "dispatch", capability: row.input.selection.deliveryKind === "parcel-locker" ? "pickupPoint" : "dispatch", slotId: kit?.dispatch?.addressAfterSubmission === index ? "dispatch:addressAfter" : transportNames.find(name => kit?.dispatch?.transport[name].fixture === index) ? `dispatch:${transportNames.find(name => kit?.dispatch?.transport[name].fixture === index)}` : `dispatch:${index}`, input: [row.input, prepared.evidence], expected: row.expectedDispatch, faults: logs.get(index), label: "dispatch fixture" });
      if (result.kind === "accepted") same(result.evidence, prepared.evidence, "dispatch fingerprint identity");
      if (row.replay) await witness({ op: "dispatch", capability: "replay", slotId: `replay:${index}`, input: [row.input, prepared.evidence], expected: row.expectedDispatch, zero: "replay no second I/O", replay: true, label: "dispatch replay" });
      passed(`dispatch ${result.kind}, fingerprint, mismatch and replay`);
    }
    for (const op of ["create", "read", "void"] as const) {
      const capability = ({ create: "labelCreate", read: "labelRead", void: "labelVoid" } as const)[op], supported = caps.operations[capability].supported;
      if (supported) requireFact(fixtures.label?.[op]?.length, `label ${op} fixture`);
      for (const [i, row] of (fixtures.label?.[op] ?? []).entries()) { await witness({ op, capability, slotId: `label:${op}:${i}`, input: row.input, expected: row.expected, zero: !supported && (mode === "full" || caps.labelReadOwner !== "host_storage" || op !== "read") ? "unsupported label before I/O" : undefined, label: `label ${op}` }); passed(`label ${op}`); }
    }
    const events = new Map<string, unknown>();
    const observe = async (index: number, slotId: string, retry: boolean) => {
      const row = fixtures.observation![index]!;
      const result = await witness({ op: "observation", capability: "verifyObservation", slotId, input: row.input, expected: row.expected, zero: !caps.operations.verifyObservation.supported && mode === "full" ? "unsupported observation before I/O" : undefined, label: "observation fixture" });
      if (result.kind === "verified") {
        same(result.observation, projectObservation(result.observation, subject.approveTrackingUrl, subject.observationCodecs), "observation allowlist");
        const value = result.observation, identity = { provider: value.fact.providerKind, reference: value.fact.fulfillmentReference, kind: value.eventKind, outcome: value.fact.canonicalStatus, occurredAt: value.fact.occurredAt };
        if (events.has(value.eventKey)) same(events.get(value.eventKey), identity, "eventKey includes outcome and occurrence"); events.set(value.eventKey, identity);
        if (retry) await witness({ op: "observation", capability: "observationReplay", slotId: `${slotId}:retry`, input: row.input, expected: row.expected, label: "observation exact retry" });
      }
    };
    if (caps.operations.verifyObservation.supported) requireFact(fixtures.observation?.length, "observation fixtures required");
    for (const [i] of (fixtures.observation ?? []).entries()) { await observe(i, kit?.observation?.authenticationFailure === i ? "observation:auth" : `observation:${i}`, true); passed("observation identity, replay and redaction"); }
    if (caps.operations.readback.supported) requireFact(fixtures.readback?.length, "readback fixtures required");
    for (const [i, row] of (fixtures.readback ?? []).entries()) {
      const result = await witness({ op: "readback", capability: "readback", slotId: kit?.exceptions?.returned === i ? "exception:returned" : kit?.exceptions?.lostCoarse === i ? "exception:lostCoarse" : `readback:${i}`, input: row.input, expected: row.expected, zero: !caps.operations.readback.supported && mode === "full" ? "unsupported readback before I/O" : undefined, label: "readback fixture" });
      if (row.localMissing) requireFact(result.kind === "unknown" && result.refusal.reason === "local_missing", "local missing is never absence");
      if (result.kind === "absent") { requireFact(caps.operations.exactAbsence.supported, "unsupported exact absence refuses"); const { mode: _mode, ...scope } = row.input[0]; same(result.scope, scope, "absence scope"); }
      if (result.kind === "found") { requireFact(result.externalRef === row.input[0].externalRef || row.input[0].externalRef === null, "found identity"); same(result.observation, projectObservation(result.observation, subject.approveTrackingUrl, subject.observationCodecs), "readback observation allowlist"); }
      passed(`readback ${result.kind}`);
    }
    for (const name of ["stockSync", "productSync"] as const) {
      const capability = name === "stockSync" ? "syncStock" : "syncProducts", supported = caps.operations[capability].supported;
      if (supported) requireFact(fixtures[name]?.length, `${name} fixtures required`);
      for (const [i, row] of (fixtures[name] ?? []).entries()) { const expected = row.expected as { kind?: string; refusal?: FulfillmentRefusal } | null;
        await witness({ op: row.operation, capability, slotId: `${name}:${i}`, input: row.input, ...(expected?.kind === "refused" ? { throws: expected.refusal! } : { expected: row.expected }), zero: !supported && mode === "full" ? "unsupported sync before I/O" : undefined, label: `${name} ${row.operation}` }); passed(`${name} ${row.operation}`);
      }
    }
    if (mode === "full") {
      if (profile === "adapter") {
        if (kit!.dispatchRefusal) await witness({ op: "dispatch", capability: "dispatch", slotId: "unsupportedDispatch", ...kit!.dispatchRefusal, zero: "unsupported dispatch before I/O", label: "unsupported dispatch" });
        for (const [operation, reason] of [["cancel", "provider_cancel_unsupported"], ["independentSplit", "independent_split_unsupported"], ["reservations", "provider_reservations_unsupported"], ["pickupPointDelivery", "pickup_point_delivery_unsupported"]] as const) {
          ports.native = async () => readFulfillmentCapabilities([caps], first.input.selection, { operation });
          await witness({ op: "native", capability: operation === "cancel" ? "cancel" : operation === "pickupPointDelivery" && !caps.operations.pickupPoint.supported ? "pickupPoint" : `native:${operation}`, slotId: `native:${operation}`, input: [], expected: { kind: "refused", refusal: { reason, phase: "selection", retryable: false } }, zero: `native ${reason} before I/O`, label: `native ${reason}` }); passed(`native refusal:${reason}`);
        }
        ports.native = async () => readFulfillmentCapabilities([caps], first.input.selection, { format: "application/zpl" });
        await witness({ op: "native", capability: "native:format", slotId: "native:format", input: [], expected: { kind: "refused", refusal: { reason: "label_format_unsupported", phase: "selection", retryable: false } }, zero: "native format before I/O", label: "native label_format_unsupported" }); passed("native refusal:label_format_unsupported");
        if (kit!.observation) for (const name of ["duplicate", "outOfOrder"] as const) for (const [i, index] of kit!.observation[name].entries()) await observe(index, `${name}:${i}`, false);
        for (const name of ["stockSync", "productSync"] as const) for (const row of (kit![name] ?? []) as NonNullable<NonNullable<FulfillmentAdapterTestSubject["certification"]>[typeof name]>) for (const role of ["success", "failure"] as const) await witness({ op: row.operation, capability: name === "stockSync" ? "syncStock" : "syncProducts", slotId: `full:${row.operation}:${role}`, ...row[role], positive: role === "success", label: `full ${row.operation}` });
        if (kit!.paging) for (const name of ["full", "short", "empty", "exhausted", "failure"] as const) await witness({ op: "page", capability: "paging", slotId: `paging:${name}`, input: [kit!.paging[name].input], expected: kit!.paging[name].expected, positive: name === "full" || name === "short", label: `full paging ${name}` });
        if (caps.operations.exactAbsence.supported) for (const kind of ["absent", "unknown"] as const) {
          const row = fixtures.readback?.find(row => row.expected.kind === kind); requireFact(row, "full authoritative absence and failure required");
          await witness({ op: "readback", capability: "exactAbsence", slotId: `exactAbsence:${kind}`, input: row.input, expected: row.expected, label: "exactAbsence fixture" });
        }
        if (!caps.operations.exactAbsence.supported) await witness({ op: "readback", capability: "exactAbsence", slotId: "exactAbsence:refusal", input: [{ ...fixtures.readback![0]!.input[0], externalRef: null }], expected: { kind: "unsupported", refusal: unsupported("readback") }, zero: "unsupported exactAbsence before I/O", label: "exactAbsence refusal" });
        if (kit!.snapshotOnly) { let movementCalls = 0;
          ports.native = async () => { const result = await runFulfillmentStockSyncWorker({ stockMovements: false, movementBatchSize: 1, now: () => new Date("2026-01-01T00:00:00Z"), compatibility: { syncRunId: () => "offline", timeZone: "UTC", staleEvidenceSku: "sentinel", currentKey: () => "current", snapshotKey: () => "snapshot", lowStockKey: () => "low", staleKey: () => "stale" }, provider: { getStock: async () => [], getStockMovements: async () => { movementCalls++; return []; } }, port: { readCursor: async () => null, recordCursor: async () => {}, readLocalInventoryStock: async () => [], readSkuInventoryClasses: async () => new Map(), readActiveReservations: async () => new Map(), recordStockSnapshot: async () => ({ replayed: false, readBack: true }), recordProviderStockCurrent: async () => ({ replayed: false, readBack: true }), recordMovement: async () => ({ replayed: false, readBack: true }), recordLowStockEvidence: async () => ({ replayed: false }), resolveLowStockEvidence: async () => ({ resolved: 0 }) } }); requireFact(movementCalls === 0, "snapshot-only no movement I/O"); return { kind: "refused", refusal: result.movementRefusal }; };
          await witness({ op: "native", capability: "native:movements", slotId: "native:movements", input: [], expected: { kind: "refused", refusal: { reason: "stock_movements_unsupported", phase: "sync", retryable: false } }, zero: "snapshot-only provider I/O", label: "full snapshot-only refusal" }); passed("native refusal:stock_movements_unsupported");
        }
      }
      checkFull(caps, freeze(ledger), profile); passed(profile === "adapter" ? "full:adapter (offline; no durable host qualification)" : "full:dispatch-only (no other capability certified)");
    }
    if (subject.store) { await checkStore(subject); passed("store G14 replay, own-key remap and one-remap bound"); }
    assertDurable({ subjectId: subject.subjectId, providerRef: caps.providerRef }, subject); evidence.push({ subjectId: subject.subjectId, providerRef: caps.providerRef });
    qualifications.push({ subjectId: subject.subjectId, profile, capabilityDigest: createHash("sha256").update(JSON.stringify(caps)).digest("hex"), ledger: ledger.map(({ capability, role, slotId, ioDelta, faultLogDelta }) => ({ capability, role, slotId, ioDelta, faultLogDelta })), declarations: PORTLESS_CAPABILITIES.filter(capability => !caps.operations[capability].supported).map(capability => ({ capability, declared: "unsupported", probe: "no_port" })) });
  }
  return { subjects: evidence, cases, mode, qualifications };
}

function validateFull(data: { capabilities: FulfillmentCapabilityDescriptor; fixtures: Subject["fixtures"]; certification?: FulfillmentAdapterTestSubject["certification"] }, profile: string): void {
  const { capabilities: caps, fixtures, certification: kit } = data;
  requireFact(kit, "full certification fixtures required");
  for (const capability of [...PORTLESS_CAPABILITIES, "cancel"] as const) requireFact(!caps.operations[capability].supported, `capability_not_certifiable:${capability}`);
  if (profile === "adapter") {
  requireFact(!caps.operations.exactAbsence.supported || caps.operations.readback.supported, "capability_not_certifiable:exactAbsence without readback");
  for (const [capability, rows] of [["labelCreate", fixtures.label?.create], ["labelRead", fixtures.label?.read], ["labelVoid", fixtures.label?.void], ["verifyObservation", fixtures.observation], ["readback", fixtures.readback], ["syncStock", fixtures.stockSync], ["syncProducts", fixtures.productSync]] as const) {
    if (!caps.operations[capability].supported) requireFact(rows?.length, `full unsupported ${capability} refusal probe required`);
  }
  }
  const indices = (values: number[], length: number, label: string) => requireFact(values.every(value => Number.isInteger(value) && value >= 0 && value < length) && new Set(values).size === values.length, `validation:scenario_indices:${label}`);
  if (kit.dispatch) {
    const scenarios = kit.dispatch;
    indices([scenarios.addressBeforeSubmission, scenarios.addressAfterSubmission, ...transportNames.map(name => scenarios.transport[name].fixture)], fixtures.dispatch.length, "dispatch");
    const before = fixtures.dispatch[scenarios.addressBeforeSubmission]!;
    requireFact(before.expectedPrepare.kind === "refused" && before.expectedPrepare.refusal.reason === "not_dispatchable", "full address before submission");
    requireFact(before.input.lines.length && before.input.lines.every(line => line.skuRef.trim() && line.quantity > 0) && [before.input.recipient.line1, before.input.recipient.city, before.input.recipient.postalCode, before.input.recipient.country].some(value => !value.trim()), "full address invalid with valid items");
  }
  if (kit.observation) {
    indices([...kit.observation.duplicate, ...kit.observation.outOfOrder, kit.observation.authenticationFailure], fixtures.observation?.length ?? 0, "observation");
    same(fixtures.observation![kit.observation.duplicate[0]]!.input, fixtures.observation![kit.observation.duplicate[1]]!.input, "full duplicate input");
  }
  if (kit.exceptions) indices([kit.exceptions.returned, kit.exceptions.lostCoarse], fixtures.readback?.length ?? 0, "exceptions");
  if (profile === "dispatch-only") { requireFact(caps.operations.dispatch.supported && Object.entries(caps.operations).every(([key, value]) => key === "dispatch" || !value.supported), "dispatch-only capability profile"); return; }
  if (caps.operations.dispatch.supported) requireFact(kit.dispatch, "full dispatch scenarios required");
  if (caps.operations.verifyObservation.supported) requireFact(kit.observation, "full observation scenarios required");
  if (caps.operations.readback.supported) { requireFact(kit.exceptions, "full exception fixtures required"); requireFact(kit.paging, "full numbered paging fixtures required"); }
  for (const name of ["stockSync", "productSync"] as const) if (caps.operations[name === "stockSync" ? "syncStock" : "syncProducts"].supported) {
    const ops = name === "stockSync" ? ["getStock", ...(caps.stockMovements === false ? [] : ["getStockMovements"])] : ["ensureProduct", "getProductPacks", "addProductPack", "listStockedSkus"];
    requireFact(ops.every(op => kit[name]?.filter(row => row.operation === op).length === 1), `full ${name} witnesses required`);
  }
  if (caps.operations.syncStock.supported || caps.stockMovements === false) requireFact(kit.snapshotOnly, "full snapshot-only refusal probe required");
}
/** Pure coverage and scenario checks. Only recorded invocations are visible here. */
function checkFull(caps: FulfillmentCapabilityDescriptor, ledger: readonly Entry[], profile: string): void {
  const entries = (capability: string) => ledger.filter(row => row.capability === capability);
  const slot = (id: string) => { const row = ledger.find(row => row.slotId === id); requireFact(row, `full scenario_witness_missing:${id}`); return row; };
  const success = (row: Entry) => row.role === "success", failure = (row: Entry) => row.role === "failure";
  for (const [capability, declared] of Object.entries(caps.operations)) {
    if (PORTLESS_CAPABILITIES.some(value => value === capability) || (profile === "dispatch-only" && capability !== "dispatch")) continue;
    const rows = entries(capability);
    if (declared.supported) requireFact(rows.some(row => success(row) && (capability !== "dispatch" || row.kind === "accepted")) && rows.some(row => failure(row) && (capability !== "dispatch" || row.kind === "not_dispatched")), `full ${capability} success and failure required`);
    else requireFact(rows.some(row => row.role === "refusal" && row.ioDelta === 0), `full unsupported ${capability} refusal probe required`);
  }
  requireFact(ledger.some(row => row.slotId.startsWith("prepare:") && row.kind === "refused"), "full preparation refusal required");
  if (caps.operations.dispatch.supported) requireFact(ledger.some(row => row.slotId.startsWith("replay:") && row.kind === "unknown" && row.replay), "full unknown replay required");
  if (profile === "dispatch-only") return;
  if (caps.operations.dispatch.supported) {
    requireFact(slot("prepare:addressBefore").kind === "refused", "full address before submission");
    const after = slot("dispatch:addressAfter"), result = after.value as z.output<typeof results.dispatch>;
    requireFact(result.kind === "not_dispatched" && result.error?.submissionAttempted === true && result.error.mayHaveSucceeded === false, "full address after submission"); requireFact(after.ioDelta === 1, "full address after submission I/O");
    for (const name of transportNames) { const row = slot(`dispatch:${name}`), result = row.value as z.output<typeof results.dispatch>, uncertain = name !== "transport-before-submission";
      requireFact(row.faultLogDelta.length === 1 && row.faultLogDelta[0]!.kind === name, `full ${name} injected fault required for dispatch invocation`);
      requireFact(result.kind === (uncertain ? "unknown" : "not_dispatched") && result.error?.mayHaveSucceeded === uncertain && result.error.submissionAttempted === uncertain, `full ${name} uncertainty`);
      requireFact(row.ioDelta === (uncertain ? 1 : 0), `full ${name} submission I/O`); if (name === "http-failure") requireFact((result.error?.status ?? 0) >= 500, "full HTTP 5xx");
    }
  }
  if (caps.operations.verifyObservation.supported) {
    const observed = (id: string) => { const row = slot(id), value = row.value as z.output<typeof results.observation>; requireFact(value.kind === "verified", "full verified status required"); return value.observation; };
    same(observed("duplicate:0"), observed("duplicate:1"), "full duplicate status"); const newer = observed("outOfOrder:0"), older = observed("outOfOrder:1");
    requireFact(newer.eventKey !== older.eventKey && Date.parse(newer.fact.occurredAt ?? "") > Date.parse(older.fact.occurredAt ?? ""), "full out-of-order chronology supplied");
    same({ correlation: newer.correlation, provider: newer.fact.providerKind, fulfillment: newer.fact.fulfillmentReference }, { correlation: older.correlation, provider: older.fact.providerKind, fulfillment: older.fact.fulfillmentReference }, "full out-of-order same shipment");
    const auth = slot("observation:auth").value as z.output<typeof results.observation>; requireFact(auth.kind === "refused" && auth.refusal.reason === "untrusted" && auth.refusal.phase === "verify", "full authentication refusal");
  }
  if (caps.operations.readback.supported) { for (const name of ["returned", "lostCoarse"] as const) { const result = slot(`exception:${name}`).value as z.output<typeof results.readback>; requireFact(result.kind === "found" && result.observation.fact.canonicalStatus === "exception", `full ${name} coarse exception`); }
    requireFact(entries("readback").some(row => row.kind === "unknown" && (row.value as { refusal: FulfillmentRefusal }).refusal.reason === "local_missing"), "full unknown versus absent");
    for (const name of ["full", "short", "empty"] as const) { const row = slot(`paging:${name}`), result = row.value as z.output<typeof results.page>, size = (row.input[0] as { size: number }).size;
      requireFact(result.kind === "page" && (name === "full" ? result.rows.length === size : name === "empty" ? result.rows.length === 0 : result.rows.length > 0 && result.rows.length < size), `full paging ${name} shape`); }
  }
}
async function checkStore(subject: Subject): Promise<void> {
  const fixture = subject.store!;
  const store = await fixture.create();
  const first = await store.claim(fixture.claim);
  requireFact(storeResult("claim", first, subject).kind === "claimed", "store initial claim");
  const replay = await store.claim(fixture.claim);
  requireFact(storeResult("claim", replay, subject).kind === "claimed" && replay.kind === "claimed" && replay.record.replayed, "store same-key claim replay");
  const attempt = () => store.recordProviderAttempt(fixture.mappedAttemptKey, fixture.claim.fulfillmentRef, fixture.claim.evidence, fixture.claim.mode, "recorded");
  requireFact(storeResult("attempt", await attempt(), subject).kind === "recorded" && storeResult("attempt", await attempt(), subject).kind === "replayed", "G14 same key replays");
  requireFact(fixture.mappedAttemptKey !== fixture.remappedAttemptKey, "G14 remap own key");
  requireFact(fixture.claim.requestKey === fixture.remappedClaim.requestKey && fixture.claim.evidence.commandFingerprint !== fixture.remappedClaim.evidence.commandFingerprint, "draft remap fixture");
  const remap = await store.claim(fixture.remappedClaim);
  requireFact(storeResult("claim", remap, subject).kind === "claimed", "draft re-claim");
  const row = await store.read(fixture.claim.requestKey);
  same(row?.evidence, fixture.remappedClaim.evidence, "atomic remap fingerprint and evidence");
  assertDurable(row, subject);
  requireFact(storeResult("attempt", await store.recordProviderAttempt(fixture.remappedAttemptKey, fixture.claim.fulfillmentRef, fixture.remappedClaim.evidence, fixture.claim.mode, "recorded"), subject).kind === "recorded", "G14 new mapped attempt");
  const attempts = await store.readMappedAttempts();
  requireFact(attempts.length === 2, "G14 no duplicate durable attempts");
  same(attempts.map(row => row.attemptKey).sort(), [fixture.mappedAttemptKey, fixture.remappedAttemptKey].sort(), "G14 durable remap identity");
  for (const attempt of attempts) {
    same(attempt.preparedEvidence, dispatchEvidence(attempt.preparedEvidence), "G14 sanitized evidence only");
    assertDurable(attempt, subject);
  }
  const stale = await store.begin({ dispatchRef: row!.dispatchRef, commandFingerprint: fixture.claim.evidence.commandFingerprint });
  requireFact(storeResult("begin", stale, subject).kind === "refused", "stale prepared command refuses");
  let claims = 0; let calls = 0; let reads = 0;
  const bounded = await runFulfillmentDispatchWorker({
    store: { ...await fixture.create(), async read() { return null; }, async readCandidate() { reads += 1; return reads === 1 ? fixture.request : fixture.remappedRequest; },
      async claim() { claims += 1; return { kind: "refused", refusal: { reason: "contact_stale", phase: "claim", retryable: true } }; } },
    provider: { prepare: request => subject.adapter.dispatch.prepare(request), async dispatch() { calls += 1; throw new Error("unexpected dispatch"); } },
    listCandidates: async () => [fixture.request], config: { mode: "stage", batchLimit: 1 },
    keys: { request: () => fixture.claim.requestKey, mappedAttempt: (_key, index) => index === 0 ? fixture.mappedAttemptKey : fixture.remappedAttemptKey,
      acceptance: () => ({ providerAttemptKey: "fixture-attempt", labelKey: "fixture-label" }) },
  });
  requireFact(storeResult("worker", bounded, subject).kind === "refused" && claims === 2 && calls === 0, "one-remap limit before I/O");
}
function assertDurable(value: unknown, subject: Subject): void {
  const text = JSON.stringify(value) ?? "";
  requireFact(!subject.sensitiveValues.filter(Boolean).some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))), "durable secret redaction");
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      requireFact(!/^(rawBody|rawPayload|rawCommand|password|secret|credential|authorization|headers|signedUrl)$/i.test(key), "durable field allowlist");
      if (typeof child === "string") requireFact(!/[?&](?:signature|sig|token|x-amz-signature|credential)=/i.test(child), "durable signed URL");
      visit(child);
    }
  };
  visit(value);
}
// Optional platform-store probes assert their own contracts; they grant no adapter coverage.
function storeResult(operation: string, value: unknown, subject: Subject): { kind: string } {
  const result = snapshot(value) as Record<string, unknown>; assertDurable(result, subject);
  if (operation === "claim" || operation === "begin") {
    const kind = result.kind; requireFact(typeof kind === "string" && (kind === "refused" || kind === (operation === "claim" ? "claimed" : "begun")), `${operation} contradictory result`);
    requireFact(kind === "refused" ? Object.keys(result).every(key => ["kind", "refusal"].includes(key)) && refusal.safeParse(result.refusal).success : !Object.hasOwn(result, "refusal") && Boolean(result.record), `${operation} contradictory result`); return { kind };
  }
  if (operation === "attempt") { requireFact(typeof result.replayed === "boolean" && Object.keys(result).every(key => key === "replayed"), "attempt contradictory result"); return { kind: result.replayed ? "replayed" : "recorded" }; }
  requireFact(typeof result.ok === "boolean" && !Object.hasOwn(result, "refusal"), "worker contradictory result"); return { kind: result.ok ? "completed" : "refused" };
}
