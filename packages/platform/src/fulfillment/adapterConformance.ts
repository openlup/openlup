import type { FulfillmentAdapterConformanceEvidence, FulfillmentAdapterConformanceSubject, FulfillmentRefusal } from "./contracts/index.js";
import type { FulfillmentAdapterTestSubject, FulfillmentConformanceOptions } from "./testing/scenarios.js";
import { dispatchEvidence, dispatchResult } from "./dispatchProjection.js";
import { projectObservation } from "./observationProjection.js";
import { readFulfillmentCapabilities } from "./providerCapabilities.js";
import { runFulfillmentDispatchWorker } from "./providerDispatchWorker.js";

type Subject = FulfillmentAdapterConformanceSubject;
type DispatchWitness = {
  credit: Credit;
  result: NonNullable<Subject["fixtures"]["dispatch"][number]["expectedDispatch"]>;
  replayed: boolean;
  ioDelta: number;
  faults: Map<string, readonly { kind: string }[]>;
};
/** Runner-independent offline proof using only adapter-owned fixtures. Throws on a violated contract. */
export async function runFulfillmentAdapterConformance(subjects: readonly FulfillmentAdapterTestSubject[], options: FulfillmentConformanceOptions = { mode: "baseline" }): Promise<FulfillmentAdapterConformanceEvidence> {
  requireFact(options.mode === "baseline" || options.mode === "full", "qualification mode");
  if (options.mode === "full") requireFact(subjects.length > 0, "full subjects required");
  const evidence: { subjectId: string; providerRef: string }[] = [];
  const cases: { subjectId: string; operation: string; passed: true }[] = [];
  for (const subject of subjects) {
    const { adapter, fixtures } = subject;
    const caps = adapter.capabilities;
    const passed = (operation: string) => { cases.push({ subjectId: subject.subjectId, operation, passed: true }); };
    requireFact(caps.defaultOff === true, "default-off");
    requireFact(creditResult("selection", readFulfillmentCapabilities([caps], null), subject).kind === "refused", "selection_required");
    const first = fixtures.dispatch[0];
    requireFact(Boolean(first), "dispatch fixture required");
    const disabled = readFulfillmentCapabilities([{ ...caps, selected: false }], first.input.selection);
    requireFact(creditResult("selection", disabled, subject).kind === "refused" && disabled.kind === "refused" && disabled.refusal.reason === "disabled", "disabled selection");
    const selectionCalls = subject.readIoCount();
    const missing = await adapter.dispatch.prepare({ ...first.input, selection: { ...first.input.selection, providerRef: null } });
    requireFact(creditResult("prepare", missing, subject).kind === "refused" && missing.kind === "refused" && missing.refusal.reason === "selection_required", "adapter selection_required");
    requireFact(subject.readIoCount() === selectionCalls, "selection refusal before I/O");
    passed("default-off and selection_required");
    const dispatchWitnesses = new Map<number, DispatchWitness>();
    for (const [index, fixture] of fixtures.dispatch.entries()) {
      const before = subject.readIoCount();
      const prepared = await adapter.dispatch.prepare(fixture.input);
      const preparation = creditResult("prepare", prepared, subject, fixture.expectedPrepare, "prepare fixture");
      requireFact(subject.readIoCount() === before, "prepare before I/O");
      assertDurable(prepared, subject);
      if (preparation.role === "failure") {
        requireFact(fixture.expectedDispatch === undefined && fixture.replay === undefined, "refused preparation cannot declare dispatch or replay");
        passed("dispatch refused before I/O"); continue;
      }
      requireFact(prepared.kind === "prepared" && caps.operations.dispatch.supported, "unsupported dispatch refuses");
      requireSame(prepared.evidence, dispatchEvidence(prepared.evidence), "prepared evidence allowlist");
      requireFact(prepared.evidence.providerRef === fixture.input.selection.providerRef, "prepared provider identity");
      requireSame(prepared.evidence.contactRevision, fixture.input.contactRevision, "prepared contact identity");
      const mismatch = await adapter.dispatch.dispatch(fixture.input, { ...prepared.evidence, commandFingerprint: `${prepared.evidence.commandFingerprint}:mismatch` });
      creditResult("dispatch", mismatch, subject, { kind: "not_dispatched", effectMayHaveSucceeded: false,
        refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } }, "mismatched preparation refusal");
      requireFact(subject.readIoCount() === before, "mismatch before I/O");
      requireFact(fixture.expectedDispatch !== undefined, "dispatch expected result");
      const faults = Object.entries(subject.certification?.dispatch?.transport ?? {})
        .filter(([, scenario]) => scenario.fixture === index)
        .map(([name, scenario]) => ({ name, calls: scenario.calls, start: scenario.calls.length }));
      const dispatchCalls = subject.readIoCount();
      const result = await adapter.dispatch.dispatch(fixture.input, prepared.evidence);
      const resultCredit = creditResult("dispatch", result, subject, fixture.expectedDispatch, "dispatch fixture");
      const witness: DispatchWitness = { credit: resultCredit, result, replayed: false, ioDelta: subject.readIoCount() - dispatchCalls,
        faults: new Map(faults.map(({ name, calls, start }) => [name, calls.slice(start)])) };
      requireSame(result, dispatchResult(result), "dispatch allowlist");
      assertDurable(result, subject);
      if (resultCredit.role === "success" && result.kind === "accepted") {
        requireSame(result.evidence, prepared.evidence, "dispatch fingerprint identity");
        requireFact(result.externalRef.length > 0 && result.providerAttemptKey.length > 0 && result.labelKey.length > 0, "accepted proof before local ACK");
      }
      if (fixture.replay) {
        const calls = subject.readIoCount();
        creditResult("dispatch", await adapter.dispatch.dispatch(fixture.input, prepared.evidence), subject, result, "dispatch replay");
        requireFact(subject.readIoCount() === calls, "replay no second I/O");
        witness.replayed = true;
      }
      dispatchWitnesses.set(index, witness);
      passed(`dispatch ${result.kind}, fingerprint, mismatch and replay`);
    }
    for (const operation of ["create", "read", "void"] as const) {
      const supported = caps.operations[operation === "create" ? "labelCreate" : operation === "read" ? "labelRead" : "labelVoid"].supported;
      const rows = fixtures.label?.[operation] ?? [];
      if (supported) requireFact(Boolean(adapter.label) && rows.length > 0, `label ${operation} fixture`);
      if (rows.length) requireFact(Boolean(adapter.label), "label port required");
      for (const fixture of rows) {
        const before = subject.readIoCount();
        const result = operation === "create" ? await adapter.label!.create((fixture as NonNullable<Subject["fixtures"]["label"]>["create"] extends readonly (infer F)[] | undefined ? F : never).input[0])
          : operation === "read" ? await adapter.label!.read((fixture as NonNullable<NonNullable<Subject["fixtures"]["label"]>["read"]>[number]).input[0])
          : await adapter.label!.void((fixture as NonNullable<NonNullable<Subject["fixtures"]["label"]>["void"]>[number]).input[0]);
        const labelCredit = creditResult(operation, result, subject, fixture.expected, `label ${operation}`);
        if (!supported && (options.mode === "full" || !(operation === "read" && caps.labelReadOwner === "host_storage"))) {
          requireFact(labelCredit.role === "failure" && labelCredit.kind === "refused" && "refusal" in result && result.refusal?.reason === "unsupported", `unsupported label ${operation}`);
          requireFact(subject.readIoCount() === before, "unsupported label before I/O");
        }
        passed(`label ${operation}`);
      }
    }
    if (caps.operations.verifyObservation.supported) requireFact(Boolean(adapter.observation) && Boolean(fixtures.observation?.length), "observation fixtures required");
    const events = new Map<string, { identity: string; occurredAt: string | null }>();
    const observe = async (index: number, retry = true) => {
      const fixture = fixtures.observation?.[index];
      requireFact(Boolean(fixture), "observation fixture required");
      requireFact(Boolean(adapter.observation), "observation port required");
      const before = subject.readIoCount();
      const result = await adapter.observation!.verifyAndNormalize(...fixture!.input);
      const observationCredit = creditResult("observation", result, subject, fixture!.expected, "observation fixture");
      if (options.mode === "full" && observationCredit.role === "failure" && result.kind === "refused" && result.refusal.reason === "untrusted") requireFact(subject.readIoCount() === before, "authentication refusal before I/O");
      if (!caps.operations.verifyObservation.supported) requireFact(observationCredit.role === "failure" && result.kind === "refused" && result.refusal.reason === "unsupported", "unsupported observation");
      if (options.mode === "full" && !caps.operations.verifyObservation.supported) requireFact(subject.readIoCount() === before, "unsupported observation before I/O");
      if (observationCredit.role === "success" && result.kind === "verified") {
        requireSame(result.observation, projectObservation(result.observation, subject.approveTrackingUrl, subject.observationCodecs), "observation allowlist");
        const observation = result.observation;
        const identity = stable({ provider: observation.fact.providerKind, reference: observation.fact.fulfillmentReference,
          kind: observation.eventKind, outcome: observation.fact.canonicalStatus, occurredAt: observation.fact.occurredAt });
        const previous = events.get(observation.eventKey);
        if (previous) requireFact(previous.identity === identity, "eventKey includes outcome and occurrence");
        events.set(observation.eventKey, { identity, occurredAt: observation.fact.occurredAt });
        if (retry) {
          const replay = await adapter.observation!.verifyAndNormalize(...fixture!.input);
          creditResult("observation", replay, subject, result, "observation exact retry");
        }
      }
      return result;
    };
    for (const [index] of (fixtures.observation ?? []).entries()) {
      await observe(index);
      passed("observation identity, replay and redaction");
    }
    if (caps.operations.readback.supported) requireFact(Boolean(adapter.readback) && Boolean(fixtures.readback?.length), "readback fixtures required");
    for (const fixture of fixtures.readback ?? []) {
      requireFact(Boolean(adapter.readback), "readback port required");
      const before = subject.readIoCount();
      const result = await adapter.readback!.read(...fixture.input);
      const readbackCredit = creditResult("readback", result, subject, fixture.expected, "readback fixture");
      if (!caps.operations.readback.supported) requireFact(readbackCredit.kind === "unsupported", "unsupported readback");
      if (options.mode === "full" && !caps.operations.readback.supported) requireFact(subject.readIoCount() === before, "unsupported readback before I/O");
      if (fixture.localMissing) requireFact(readbackCredit.kind === "unknown" && result.kind === "unknown" && result.refusal.reason === "local_missing", "local missing is never absence");
      if (readbackCredit.kind === "absent" && result.kind === "absent") {
        requireFact(caps.operations.exactAbsence.supported, "unsupported exact absence refuses");
        const { mode: _mode, ...scope } = fixture.input[0];
        requireSame(result.scope, scope, "absence scope");
        requireFact(result.proof.kind === "authoritative_exact_lookup" && /^evidence:.+/.test(result.proof.evidenceRef) && Number.isFinite(Date.parse(result.proof.checkedAt)), "absence proof");
      }
      if (readbackCredit.kind === "found" && result.kind === "found") requireFact(result.externalRef === fixture.input[0].externalRef || fixture.input[0].externalRef === null, "found identity");
      passed(`readback ${result.kind}`);
    }
    for (const name of ["stockSync", "productSync"] as const) {
      const supported = caps.operations[name === "stockSync" ? "syncStock" : "syncProducts"].supported;
      const port = adapter[name]; const rows = fixtures[name] ?? [];
      if (supported) requireFact(Boolean(port) && rows.length > 0, `${name} fixtures required`);
      for (const fixture of rows) {
        requireFact(Boolean(port), `${name} port required`);
        const before = subject.readIoCount();
        let outcome: InvocationOutcome;
        try {
          const method = (port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[fixture.operation];
          outcome = { kind: "returned", value: await method.apply(port, fixture.input) };
        } catch (error) { outcome = { kind: "threw", error }; }
        const syncCredit = creditInvocation(fixture.operation, outcome, subject, fixture, undefined, `${name} ${fixture.operation}`);
        if (!supported) requireFact(syncCredit.kind === "refused" && outcome.kind === "threw"
          && (outcome.error as FulfillmentRefusal).reason === "unsupported", "unsupported sync");
        if (options.mode === "full" && !supported) requireFact(subject.readIoCount() === before, "unsupported sync before I/O");
        passed(`${name} ${fixture.operation}`);
      }
    }
    if (options.mode === "full") await checkFull(subject, dispatchWitnesses, index => observe(index, false), passed);
    if (subject.store) { await checkStore(subject); passed("store G14 replay, own-key remap and one-remap bound"); }
    assertDurable({ subjectId: subject.subjectId, providerRef: caps.providerRef }, subject);
    evidence.push({ subjectId: subject.subjectId, providerRef: caps.providerRef });
  }
  return { subjects: evidence, cases };
}

async function checkStore(subject: Subject): Promise<void> {
  const fixture = subject.store!;
  const store = await fixture.create();
  const first = await store.claim(fixture.claim);
  requireFact(creditResult("claim", first, subject).kind === "claimed", "store initial claim");
  const replay = await store.claim(fixture.claim);
  requireFact(creditResult("claim", replay, subject).kind === "claimed" && replay.kind === "claimed" && replay.record.replayed, "store same-key claim replay");
  const attempt = () => store.recordProviderAttempt(fixture.mappedAttemptKey, fixture.claim.fulfillmentRef, fixture.claim.evidence, fixture.claim.mode, "recorded");
  requireFact(creditResult("attempt", await attempt(), subject).kind === "recorded" && creditResult("attempt", await attempt(), subject).kind === "replayed", "G14 same key replays");
  requireFact(fixture.mappedAttemptKey !== fixture.remappedAttemptKey, "G14 remap own key");
  requireFact(fixture.claim.requestKey === fixture.remappedClaim.requestKey && fixture.claim.evidence.commandFingerprint !== fixture.remappedClaim.evidence.commandFingerprint, "draft remap fixture");
  const remap = await store.claim(fixture.remappedClaim);
  requireFact(creditResult("claim", remap, subject).kind === "claimed", "draft re-claim");
  const row = await store.read(fixture.claim.requestKey);
  requireSame(row?.evidence, fixture.remappedClaim.evidence, "atomic remap fingerprint and evidence");
  assertDurable(row, subject);
  requireFact(creditResult("attempt", await store.recordProviderAttempt(fixture.remappedAttemptKey, fixture.claim.fulfillmentRef, fixture.remappedClaim.evidence, fixture.claim.mode, "recorded"), subject).kind === "recorded", "G14 new mapped attempt");
  const attempts = await store.readMappedAttempts();
  requireFact(attempts.length === 2, "G14 no duplicate durable attempts");
  requireSame(attempts.map(row => row.attemptKey).sort(), [fixture.mappedAttemptKey, fixture.remappedAttemptKey].sort(), "G14 durable remap identity");
  for (const attempt of attempts) {
    requireSame(attempt.preparedEvidence, dispatchEvidence(attempt.preparedEvidence), "G14 sanitized evidence only");
    assertDurable(attempt, subject);
  }
  const stale = await store.begin({ dispatchRef: row!.dispatchRef, commandFingerprint: fixture.claim.evidence.commandFingerprint });
  requireFact(creditResult("begin", stale, subject).kind === "refused", "stale prepared command refuses");
  let claims = 0; let calls = 0; let reads = 0;
  const bounded = await runFulfillmentDispatchWorker({
    store: { ...await fixture.create(), async read() { return null; }, async readCandidate() { reads += 1; return reads === 1 ? fixture.request : fixture.remappedRequest; },
      async claim() { claims += 1; return { kind: "refused", refusal: { reason: "contact_stale", phase: "claim", retryable: true } }; } },
    provider: { prepare: request => subject.adapter.dispatch.prepare(request), async dispatch() { calls += 1; throw new Error("unexpected dispatch"); } },
    listCandidates: async () => [fixture.request], config: { mode: "stage", batchLimit: 1 },
    keys: { request: () => fixture.claim.requestKey, mappedAttempt: (_key, index) => index === 0 ? fixture.mappedAttemptKey : fixture.remappedAttemptKey,
      acceptance: () => ({ providerAttemptKey: "fixture-attempt", labelKey: "fixture-label" }) },
  });
  requireFact(creditResult("worker", bounded, subject).kind === "refused" && claims === 2 && calls === 0, "one-remap limit before I/O");
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
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function requireSame(actual: unknown, expected: unknown, label: string): void { requireFact(stable(actual) === stable(expected), label); }
function requireFact(value: boolean, label: string): asserts value { if (!value) throw new Error(`fulfillment_adapter_conformance:${label}`); }

function creditResult(operation: CreditOperation, value: unknown, subject: Subject, expected: unknown = value, label: string = operation, expectedKind?: string): Credit {
  return creditInvocation(operation, { kind: "returned", value }, subject, { expected }, undefined, label, expectedKind);
}
type InvocationOutcome = { kind: "returned"; value: unknown } | { kind: "threw"; error: unknown };
type Credit = { kind: string; role: "success" | "failure" | "neutral" };
// Branch-owned fields are mutually exclusive. Shared fields (for example dispatch.error)
// remain governed by the existing projections and exact independent expectations.
const creditBranches = {
  selection: { selected: ["descriptor"], refused: ["refusal"] },
  prepare: { prepared: ["evidence"], refused: ["refusal"] },
  dispatch: { accepted: ["externalRef", "evidence", "providerAttemptKey", "labelKey", "receiptKey", "recovery"], not_dispatched: ["refusal", "effectMayHaveSucceeded"], unknown: ["refusal", "effectMayHaveSucceeded"] },
  create: { created: ["parcelRef", "document"], refused: ["refusal"] },
  read: { available: ["url", "expiresAt"], refused: ["refusal"] },
  observation: { verified: ["observation"], refused: ["refusal", "diagnostics"] },
  readback: { found: ["externalRef", "createdAt", "updatedAt", "observation"], absent: ["scope", "proof"], unknown: ["refusal"], unsupported: ["refusal"] },
  page: { page: ["rows"], page_exhausted: [], failed: ["refusal", "error"] },
  claim: { claimed: ["record"], refused: ["refusal"] },
  begin: { begun: ["record", "begun", "replayed"], refused: ["refusal"] },
} satisfies Record<string, Record<string, readonly string[]>>;
type CreditOperation = keyof typeof creditBranches | "void" | "attempt" | "worker" | "typedRefusal" | "getStock" | "getStockMovements" | "ensureProduct" | "getProductPacks" | "addProductPack" | "listStockedSkus";
type CreditFixture = { expected?: unknown; throws?: FulfillmentRefusal };
/** The only role/contradiction rule, for both expectations and observed invocations.
 * Undefined outcome validates role slots before any invocation; it earns no credit. */
function creditInvocation(operation: CreditOperation, outcome: InvocationOutcome | undefined, subject: Subject,
  fixture?: CreditFixture, role?: "success" | "failure", label: string = operation, expectedKind?: string): Credit {
  const typedRefusal = (value: unknown): void => {
    const refusal = value as FulfillmentRefusal | null | undefined;
    requireFact(Boolean(refusal) && typeof refusal?.reason === "string" && Boolean(refusal.reason)
      && typeof refusal?.phase === "string" && typeof refusal?.retryable === "boolean", `${label} typed refusal required`);
    const branchFields = Object.values(creditBranches).flatMap(branches => Object.values(branches)).flat()
      .filter(key => !["refusal", "diagnostics", "error"].includes(key));
    requireFact(![...branchFields, "kind", "refusal", "canProceed", "providerDeletion", "labelDeleted", "replayed", "skuRef", "quantityKind", "ean"].some(key => key in (value as object)), `${label} contradictory result`);
  };
  const classify = (value: unknown): Credit => {
    const record = value as Record<string, unknown> | null | undefined;
    const contradiction = () => requireFact(false, `${label} contradictory result`);
    if (operation in creditBranches) {
      requireFact(Boolean(record) && typeof record === "object", `${label} result discriminant required`);
      const branches: Record<string, readonly string[]> = creditBranches[operation as keyof typeof creditBranches];
      requireFact(typeof record!.kind === "string" && Object.hasOwn(branches, record!.kind), `${label} result discriminant required`);
      const kind = record!.kind as string, own = branches[kind]!;
      if (Object.values(branches).flat().some(key => !own.includes(key) && key in record!)) contradiction();
      if (own.includes("refusal")) typedRefusal(record!.refusal);
      if (operation === "dispatch" && kind !== "accepted") requireFact(record!.effectMayHaveSucceeded === (kind === "unknown"), `${label} contradictory result`);
      if (operation === "page" && kind === "page") {
        requireFact(Array.isArray(record!.rows), `${label} page rows required`);
        for (const row of record!.rows as unknown[]) {
          // Unmapped collection entries are not successful readback witnesses.
          if ((row as { kind?: unknown })?.kind === "unmapped") {
            requireFact(!["refusal", "observation", "scope", "proof"].some(key => key in (row as object)), `${label} contradictory result`);
          } else creditInvocation("readback", { kind: "returned", value: row }, subject);
        }
      }
      return { kind, role: ["refused", "not_dispatched", "unknown", "unsupported", "failed"].includes(kind) ? "failure" : "success" };
    }
    if (operation === "typedRefusal") { typedRefusal(value); return { kind: "refused", role: "failure" }; }
    // These contracts use boolean discriminants, array returns, or void, rather than kind.
    if (operation === "void") {
      requireFact(typeof record?.canProceed === "boolean", `${label} result discriminant required`);
      if (record.canProceed && "refusal" in record) contradiction();
      if (!record.canProceed && (record.refusal as FulfillmentRefusal | undefined)?.reason === "unsupported"
        && (record.providerDeletion !== "unconfirmed" || record.labelDeleted !== false)) contradiction();
      if (!record.canProceed) typedRefusal(record.refusal);
      return { kind: record.canProceed ? "voided" : "refused", role: record.canProceed ? "success" : "failure" };
    }
    if (record && typeof record === "object" && ("refusal" in record || "kind" in record || "error" in record)) contradiction();
    if (operation === "worker") {
      requireFact(typeof record?.ok === "boolean", `${label} result discriminant required`);
      return { kind: record.ok ? "completed" : "refused", role: record.ok ? "success" : "failure" };
    }
    if (operation === "attempt") {
      requireFact(typeof record?.replayed === "boolean", `${label} result discriminant required`);
      return { kind: record.replayed ? "replayed" : "recorded", role: record.replayed ? "neutral" : "success" };
    }
    if (operation === "ensureProduct") return { kind: record?.replayed === false ? "created" : "skipped", role: record?.replayed === false ? "success" : "neutral" };
    if (operation === "addProductPack") return { kind: value === undefined ? "written" : "invalid", role: value === undefined ? "success" : "neutral" };
    if (!Array.isArray(value)) return { kind: "invalid", role: "neutral" };
    const positive = value.map(item => {
      if (operation === "listStockedSkus") return typeof item === "string" && Boolean(item.trim());
      if (!item || typeof item !== "object") return false;
      if ("refusal" in item || "error" in item) contradiction();
      if (operation === "getProductPacks") {
        if ("kind" in item) contradiction();
        return typeof item.ean === "string" && Boolean(item.ean.trim());
      }
      if ("kind" in item) {
        if (item.kind !== "rejected" || ["skuRef", "quantityKind", "quantity", "totalQuantity", "forSaleQuantity", "reservedOrUnavailableQuantity"].some(key => key in item)) contradiction();
        return false;
      }
      return typeof item.skuRef === "string" && Boolean(item.skuRef.trim()) && item.quantityKind === (operation === "getStock" ? "snapshot" : "movement");
    }).some(Boolean);
    return { kind: positive ? "populated" : "empty", role: positive ? "success" : "neutral" };
  };
  if (role) {
    requireFact(Boolean(fixture) && (role === "success" ? "expected" in fixture! && !("throws" in fixture!) : "throws" in fixture! && !("expected" in fixture!)), `${label} ${role} fixture role`);
    if (role === "failure") {
      typedRefusal(fixture!.throws);
      requireFact(fixture!.throws!.phase === "sync", `${label} typed failure required`);
    } else requireFact(classify(fixture!.expected).role === "success", `${label} positive success required`);
  } else if (fixture) {
    if (!(operation in creditBranches) && operation !== "void" && operation !== "typedRefusal" && (fixture.expected as { kind?: unknown })?.kind === "refused") {
      const expected = fixture.expected as { kind: "refused"; refusal: FulfillmentRefusal };
      requireFact(Object.keys(expected).every(key => ["kind", "refusal"].includes(key)), `${label} contradictory result`);
      typedRefusal(expected.refusal);
    } else {
      const expected = classify(fixture.expected);
      if (expectedKind) requireFact(expected.kind === expectedKind, `${label} fixture discriminant contradicts role`);
    }
  }
  if (!outcome) return { kind: "uninvoked", role: "neutral" };
  if (role === "failure") requireFact(outcome.kind === "threw", `${label} failure did not throw`);
  if (role === "success") requireFact(outcome.kind === "returned", `${label} success did not return`);
  let credit: Credit;
  if (outcome.kind === "threw") {
    requireFact(["getStock", "getStockMovements", "ensureProduct", "getProductPacks", "addProductPack", "listStockedSkus"].includes(operation), `${label} unexpected throw`);
    typedRefusal(outcome.error);
    requireFact((outcome.error as FulfillmentRefusal).phase === "sync", `${label} typed failure required`);
    const refusal = outcome.error as FulfillmentRefusal;
    if (fixture) requireSame({ reason: refusal.reason, phase: refusal.phase, retryable: refusal.retryable }, role ? fixture.throws : (fixture.expected as { refusal?: unknown })?.refusal, label);
    credit = { kind: "refused", role: "failure" };
  } else {
    credit = classify(outcome.value);
    if (expectedKind) requireFact(credit.kind === expectedKind, `${label} result discriminant contradicts role`);
    if (fixture) requireSame(outcome.value, fixture.expected, label);
    if (role === "success") requireFact(credit.role === "success", `${label} positive success required`);
  }
  if (!(operation === "read" && credit.kind === "available")) assertDurable(outcome.kind === "returned" ? outcome.value : outcome.error, subject);
  return credit;
}

async function checkFull(subject: FulfillmentAdapterTestSubject, dispatchWitnesses: ReadonlyMap<number, DispatchWitness>,
  observe: (index: number) => Promise<NonNullable<Subject["fixtures"]["observation"]>[number]["expected"]>, passed: (operation: string) => void): Promise<void> {
  const kit = subject.certification;
  requireFact(Boolean(kit), "full certification fixtures required");
  requireFact(kit!.profile === "adapter" || kit!.profile === "dispatch-only", "full profile required");
  const { adapter, fixtures } = subject, caps = adapter.capabilities;
  const pair = (rows: readonly Credit[], name: string) => {
    requireFact(rows.some(row => row.role === "success") && rows.some(row => row.role === "failure"), `full ${name} success and failure required`);
  };
  const dispatch = fixtures.dispatch;
  if (caps.operations.dispatch.supported) {
    const witnessed = [...dispatchWitnesses.values()];
    pair(witnessed.filter(row => row.credit.kind !== "unknown").map(row => row.credit), "dispatch");
    requireFact(witnessed.some(row => row.credit.kind === "unknown" && row.replayed), "full unknown replay required");
  }
  requireFact(dispatch.some(row => creditResult("prepare", row.expectedPrepare, subject).kind === "refused"), "full preparation refusal required");
  if (kit!.profile === "dispatch-only") {
    requireFact(caps.operations.dispatch.supported, "dispatch-only dispatch required");
    requireFact(Object.entries(caps.operations).every(([key, value]) => key === "dispatch" || !value.supported), "dispatch-only capability profile");
    passed("full:dispatch-only (no other capability certified)");
    return;
  }
  const selection = dispatch[0]!.input.selection;
  // Invoke the shipped native readiness refusal, not a reconstructed result.
  for (const [request, reason] of [
    [{ format: "application/zpl" }, "label_format_unsupported"],
    [{ operation: "labelCreate" }, "label_create_unsupported"], [{ operation: "labelVoid" }, "label_void_unsupported"],
    [{ operation: "cancel" }, "provider_cancel_unsupported"], [{ operation: "independentSplit" }, "independent_split_unsupported"],
    [{ operation: "reservations" }, "provider_reservations_unsupported"], [{ operation: "pickupPointDelivery" }, "pickup_point_delivery_unsupported"],
  ] as const) {
    const before = subject.readIoCount();
    creditResult("selection", readFulfillmentCapabilities([caps], selection, request), subject, { kind: "refused", refusal: { reason, phase: "selection", retryable: false } }, `full native ${reason}`);
    if ("operation" in request && request.operation === "reservations") creditResult("selection", readFulfillmentCapabilities([{ ...caps, inventory: { reservationOwner: "provider", consumption: "finished_picking" } }], selection), subject,
      { kind: "refused", refusal: { reason, phase: "selection", retryable: false } }, "full provider-owned reservation declaration");
    requireFact(subject.readIoCount() === before, `full native ${reason} before I/O`);
    passed(`native refusal:${reason}`);
  }
  for (const operation of ["create", "read", "void"] as const) {
    const rows = fixtures.label?.[operation] ?? [];
    requireFact(Boolean(adapter.label) && rows.length > 0, `full label ${operation} refusal fixture required`);
    const supported = caps.operations[operation === "create" ? "labelCreate" : operation === "read" ? "labelRead" : "labelVoid"].supported;
    const credits = rows.map(row => creditResult(operation, row.expected, subject));
    if (supported) pair(credits, `label ${operation}`);
    else requireFact(credits.some((credit, index) => credit.role === "failure" && credit.kind === "refused"
      && "refusal" in rows[index]!.expected && rows[index]!.expected.refusal?.reason === "unsupported"), `full label ${operation} explicit refusal`);
  }
  if (caps.operations.dispatch.supported) {
    requireFact(Boolean(kit!.dispatch), "full dispatch scenarios required");
    const scenarios = kit!.dispatch!;
    const before = dispatch.find((_row, index) => index === scenarios.addressBeforeSubmission);
    requireFact(before !== undefined && creditResult("prepare", before.expectedPrepare, subject).kind === "refused" && before.expectedPrepare.kind === "refused" && before.expectedPrepare.refusal.reason === "not_dispatchable", "full address before submission");
    requireFact(before.input.lines.length > 0 && before.input.lines.every(line => Boolean(line.skuRef.trim()) && Number.isFinite(line.quantity) && line.quantity > 0)
      && [before.input.recipient.line1, before.input.recipient.city, before.input.recipient.postalCode, before.input.recipient.country].some(value => !value.trim()), "full address invalid with valid items");
    const afterWitness = dispatchWitnesses.get(scenarios.addressAfterSubmission), after = afterWitness?.result;
    requireFact(afterWitness?.credit.kind === "not_dispatched" && after?.kind === "not_dispatched" && after.error?.submissionAttempted === true && after.error.mayHaveSucceeded === false, "full address after submission");
    requireFact(afterWitness!.ioDelta > 0, "full address after submission I/O");
    for (const name of ["transport-before-submission", "transport-after-submission", "http-failure"] as const) {
      const fixture = scenarios.transport?.[name], witness = fixture && dispatchWitnesses.get(fixture.fixture), result = witness?.result;
      requireFact(Boolean(witness?.faults.get(name)?.some(call => call.kind === name)), `full ${name} injected fault required for dispatch invocation`);
      requireFact(result?.error !== undefined, `full ${name} error evidence required`);
      const uncertain = name !== "transport-before-submission";
      requireFact(witness!.credit.kind === (uncertain ? "unknown" : "not_dispatched") && result.error.mayHaveSucceeded === uncertain
        && result.error.submissionAttempted === uncertain, `full ${name} uncertainty`);
      requireFact(uncertain ? witness!.ioDelta > 0 : witness!.ioDelta === 0, `full ${name} submission I/O`);
      if (name === "http-failure") requireFact((result.error.status ?? 0) >= 500, "full HTTP 5xx");
      passed(`adapter transport:${name}`);
    }
  }
  if (caps.operations.verifyObservation.supported) {
    const rows = fixtures.observation ?? [], scenarios = kit!.observation;
    requireFact(Boolean(scenarios), "full observation scenarios required");
    const verified = (index: number) => { const result = rows.find((_row, position) => position === index)?.expected; requireFact(Boolean(result) && creditResult("observation", result, subject).kind === "verified" && result?.kind === "verified", "full verified status required"); return result.observation; };
    const a = verified(scenarios!.duplicate[0]), b = verified(scenarios!.duplicate[1]);
    requireSame(a, b, "full duplicate status");
    requireSame(rows[scenarios!.duplicate[0]]!.input, rows[scenarios!.duplicate[1]]!.input, "full duplicate input");
    const newer = verified(scenarios!.outOfOrder[0]), older = verified(scenarios!.outOfOrder[1]);
    requireFact(newer.eventKey !== older.eventKey && Date.parse(newer.fact.occurredAt ?? "") > Date.parse(older.fact.occurredAt ?? ""), "full out-of-order chronology supplied");
    requireSame({ correlation: newer.correlation, provider: newer.fact.providerKind, fulfillment: newer.fact.fulfillmentReference },
      { correlation: older.correlation, provider: older.fact.providerKind, fulfillment: older.fact.fulfillmentReference }, "full out-of-order same shipment");
    for (const pair of [scenarios!.duplicate, scenarios!.outOfOrder]) {
      for (const index of pair) await observe(index);
    }
    const auth = rows.find((_row, index) => index === scenarios!.authenticationFailure)?.expected;
    requireFact(Boolean(auth) && creditResult("observation", auth, subject).kind === "refused" && auth?.kind === "refused" && auth.refusal.reason === "untrusted" && auth.refusal.phase === "verify", "full authentication refusal");
    passed("adapter status:duplicate, out-of-order chronology and authentication refusal");
  }
  if (caps.operations.readback.supported) {
    const rows = fixtures.readback ?? [];
    pair(rows.map(row => creditResult("readback", row.expected, subject)).filter(row => ["found", "unknown"].includes(row.kind)), "readback");
    requireFact(Boolean(kit!.exceptions), "full exception fixtures required");
    for (const name of ["returned", "lostCoarse"] as const) {
      const result = rows.find((_row, index) => index === kit!.exceptions![name])?.expected;
      requireFact(Boolean(result) && creditResult("readback", result, subject).kind === "found" && result?.kind === "found" && result.observation.fact.canonicalStatus === "exception", `full ${name} coarse exception`);
      passed(`adapter exception:${name}`);
    }
    requireFact(rows.some(row => creditResult("readback", row.expected, subject).kind === "unknown" && row.localMissing), "full unknown versus absent");
    if (caps.operations.exactAbsence.supported) requireFact(rows.some(row => creditResult("readback", row.expected, subject).kind === "absent"), "full authoritative absence required");
    const pages = kit!.paging;
    requireFact(Boolean(adapter.reconciliation) && Boolean(pages), "full numbered paging fixtures required");
    for (const name of ["full", "short", "empty", "exhausted", "failure"] as const) {
      const fixture = pages![name]; requireFact(Boolean(fixture), `full paging ${name} required`);
      const result = await adapter.reconciliation!.readPage(fixture.input);
      const pageCredit = creditResult("page", result, subject, fixture.expected, `full paging ${name}`, name === "exhausted" ? "page_exhausted" : name === "failure" ? "failed" : "page");
      if (pageCredit.kind === "page" && result.kind === "page") requireFact(name === "full" ? result.rows.length === fixture.input.size && result.rows.length > 0
        : name === "empty" ? result.rows.length === 0 : result.rows.length > 0 && result.rows.length < fixture.input.size, `full paging ${name} shape`);
      passed(`adapter numbered paging:${name}`);
    }
  }
  for (const name of ["stockSync", "productSync"] as const) {
    if (!caps.operations[name === "stockSync" ? "syncStock" : "syncProducts"].supported) continue;
    const port = adapter[name], rows = kit![name];
    requireFact(Boolean(port) && Boolean(rows?.length), `full ${name} witnesses required`);
    const operations = name === "stockSync" ? ["getStock", ...(caps.stockMovements === false ? [] : ["getStockMovements"])]
      : ["ensureProduct", "getProductPacks", "addProductPack", "listStockedSkus"];
    for (const operation of operations) {
      const row = rows!.find(row => row.operation === operation);
      requireFact(Boolean(row?.success) && Boolean(row?.failure), `full ${name}.${operation} success and failure required`);
      // The same rule validates both role slots before either invocation.
      for (const role of ["success", "failure"] as const) creditInvocation(operation as CreditOperation, undefined, subject, row![role], role, `full ${operation}`);
      for (const [role, fixture] of [["success", row!.success], ["failure", row!.failure]] as const) {
        let outcome: InvocationOutcome;
        try {
          outcome = { kind: "returned", value: await (port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[operation]!.apply(port, fixture.input) };
        } catch (error) {
          outcome = { kind: "threw", error };
        }
        creditInvocation(operation as CreditOperation, outcome, subject, fixture, role, `full ${operation}`);
      }
      passed(`adapter ${name}.${operation}:success and failure`);
    }
    if (name === "stockSync") {
      const probe = kit!.snapshotOnly;
      requireFact(Boolean(probe), "full snapshot-only refusal probe required");
      const before = probe!.readMovementCalls();
      creditResult("typedRefusal", await probe!.invoke(), subject, { reason: "stock_movements_unsupported", phase: "sync", retryable: false }, "full snapshot-only refusal");
      requireFact(probe!.readMovementCalls() === before, "full snapshot-only no movement I/O");
      passed("native refusal:stock_movements_unsupported");
    }
  }
  passed("full:adapter (offline; no durable host qualification)");
}
