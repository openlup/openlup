import type { FulfillmentAdapterConformanceEvidence, FulfillmentAdapterConformanceSubject, FulfillmentRefusal } from "./contracts/index.js";
import type { FulfillmentAdapterTestSubject, FulfillmentConformanceOptions } from "./testing/scenarios.js";
import { dispatchEvidence, dispatchResult } from "./dispatchProjection.js";
import { projectObservation } from "./observationProjection.js";
import { readFulfillmentCapabilities } from "./providerCapabilities.js";
import { runFulfillmentDispatchWorker } from "./providerDispatchWorker.js";

type Subject = FulfillmentAdapterConformanceSubject;
type DispatchWitness = {
  result: NonNullable<Subject["fixtures"]["dispatch"][number]["expectedDispatch"]>;
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
    requireFact(readFulfillmentCapabilities([caps], null).kind === "refused", "selection_required");
    const first = fixtures.dispatch[0];
    requireFact(Boolean(first), "dispatch fixture required");
    const disabled = readFulfillmentCapabilities([{ ...caps, selected: false }], first.input.selection);
    requireFact(disabled.kind === "refused" && disabled.refusal.reason === "disabled", "disabled selection");
    const selectionCalls = subject.readIoCount();
    const missing = await adapter.dispatch.prepare({ ...first.input, selection: { ...first.input.selection, providerRef: null } });
    requireFact(missing.kind === "refused" && missing.refusal.reason === "selection_required", "adapter selection_required");
    requireFact(subject.readIoCount() === selectionCalls, "selection refusal before I/O");
    passed("default-off and selection_required");
    const dispatchWitnesses = new Map<number, DispatchWitness>();
    for (const [index, fixture] of fixtures.dispatch.entries()) {
      const before = subject.readIoCount();
      const prepared = await adapter.dispatch.prepare(fixture.input);
      requireSame(prepared, fixture.expectedPrepare, "prepare fixture");
      requireFact(subject.readIoCount() === before, "prepare before I/O");
      assertDurable(prepared, subject);
      if (prepared.kind === "refused") { passed("dispatch refused before I/O"); continue; }
      requireFact(caps.operations.dispatch.supported, "unsupported dispatch refuses");
      requireSame(prepared.evidence, dispatchEvidence(prepared.evidence), "prepared evidence allowlist");
      requireFact(prepared.evidence.providerRef === fixture.input.selection.providerRef, "prepared provider identity");
      requireSame(prepared.evidence.contactRevision, fixture.input.contactRevision, "prepared contact identity");
      const mismatch = await adapter.dispatch.dispatch(fixture.input, { ...prepared.evidence, commandFingerprint: `${prepared.evidence.commandFingerprint}:mismatch` });
      requireSame(mismatch, { kind: "not_dispatched", effectMayHaveSucceeded: false,
        refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } }, "mismatched preparation refusal");
      requireFact(subject.readIoCount() === before, "mismatch before I/O");
      requireFact(fixture.expectedDispatch !== undefined, "dispatch expected result");
      const faults = Object.entries(subject.certification?.dispatch?.transport ?? {})
        .filter(([, scenario]) => scenario.fixture === index)
        .map(([name, scenario]) => ({ name, calls: scenario.calls, start: scenario.calls.length }));
      const dispatchCalls = subject.readIoCount();
      const result = await adapter.dispatch.dispatch(fixture.input, prepared.evidence);
      dispatchWitnesses.set(index, { result, ioDelta: subject.readIoCount() - dispatchCalls,
        faults: new Map(faults.map(({ name, calls, start }) => [name, calls.slice(start)])) });
      requireSame(result, fixture.expectedDispatch, "dispatch fixture");
      requireSame(result, dispatchResult(result), "dispatch allowlist");
      assertDurable(result, subject);
      if (result.kind === "accepted") {
        requireSame(result.evidence, prepared.evidence, "dispatch fingerprint identity");
        requireFact(result.externalRef.length > 0 && result.providerAttemptKey.length > 0 && result.labelKey.length > 0, "accepted proof before local ACK");
      } else requireFact(result.kind === "unknown" ? result.effectMayHaveSucceeded : !result.effectMayHaveSucceeded, "unknown versus refused");
      if (fixture.replay) {
        const calls = subject.readIoCount();
        requireSame(await adapter.dispatch.dispatch(fixture.input, prepared.evidence), result, "dispatch replay");
        requireFact(subject.readIoCount() === calls, "replay no second I/O");
      }
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
        requireSame(result, fixture.expected, `label ${operation}`);
        if (!supported && (options.mode === "full" || !(operation === "read" && caps.labelReadOwner === "host_storage"))) {
          requireFact("refusal" in result && result.refusal?.reason === "unsupported", `unsupported label ${operation}`);
          requireFact(subject.readIoCount() === before, "unsupported label before I/O");
          if (options.mode === "full" && "providerDeletion" in result) requireFact(result.providerDeletion === "unconfirmed" && !result.labelDeleted && !result.canProceed, "unsupported label void cannot confirm deletion");
        }
        if (!(operation === "read" && "kind" in result && result.kind === "available")) assertDurable(result, subject);
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
      requireSame(result, fixture!.expected, "observation fixture"); assertDurable(result, subject);
      if (options.mode === "full" && result.kind === "refused" && result.refusal.reason === "untrusted") requireFact(subject.readIoCount() === before, "authentication refusal before I/O");
      if (!caps.operations.verifyObservation.supported) requireFact(result.kind === "refused" && result.refusal.reason === "unsupported", "unsupported observation");
      if (options.mode === "full" && !caps.operations.verifyObservation.supported) requireFact(subject.readIoCount() === before, "unsupported observation before I/O");
      if (result.kind === "verified") {
        requireSame(result.observation, projectObservation(result.observation, subject.approveTrackingUrl, subject.observationCodecs), "observation allowlist");
        const observation = result.observation;
        const identity = stable({ provider: observation.fact.providerKind, reference: observation.fact.fulfillmentReference,
          kind: observation.eventKind, outcome: observation.fact.canonicalStatus, occurredAt: observation.fact.occurredAt });
        const previous = events.get(observation.eventKey);
        if (previous) requireFact(previous.identity === identity, "eventKey includes outcome and occurrence");
        events.set(observation.eventKey, { identity, occurredAt: observation.fact.occurredAt });
        if (retry) {
          const replay = await adapter.observation!.verifyAndNormalize(...fixture!.input);
          requireSame(replay, result, "observation exact retry");
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
      requireSame(result, fixture.expected, "readback fixture"); assertDurable(result, subject);
      if (!caps.operations.readback.supported) requireFact(result.kind === "unsupported", "unsupported readback");
      if (options.mode === "full" && !caps.operations.readback.supported) requireFact(subject.readIoCount() === before, "unsupported readback before I/O");
      if (fixture.localMissing) requireFact(result.kind === "unknown" && result.refusal.reason === "local_missing", "local missing is never absence");
      if (result.kind === "absent") {
        requireFact(caps.operations.exactAbsence.supported, "unsupported exact absence refuses");
        const { mode: _mode, ...scope } = fixture.input[0];
        requireSame(result.scope, scope, "absence scope");
        requireFact(result.proof.kind === "authoritative_exact_lookup" && /^evidence:.+/.test(result.proof.evidenceRef) && Number.isFinite(Date.parse(result.proof.checkedAt)), "absence proof");
      }
      if (result.kind === "found") requireFact(result.externalRef === fixture.input[0].externalRef || fixture.input[0].externalRef === null, "found identity");
      passed(`readback ${result.kind}`);
    }
    for (const name of ["stockSync", "productSync"] as const) {
      const supported = caps.operations[name === "stockSync" ? "syncStock" : "syncProducts"].supported;
      const port = adapter[name]; const rows = fixtures[name] ?? [];
      if (supported) requireFact(Boolean(port) && rows.length > 0, `${name} fixtures required`);
      for (const fixture of rows) {
        requireFact(Boolean(port), `${name} port required`);
        const before = subject.readIoCount();
        let returned: unknown;
        try {
          // Dispatch a typed fixture tuple to its adapter-owned operation.
          const method = (port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[fixture.operation];
          returned = await method.apply(port, fixture.input);
        } catch (error) {
          const refusal = error as FulfillmentRefusal;
          requireFact(refusal.reason === "unsupported" && refusal.phase === "sync" && refusal.retryable === false, "typed unsupported sync refusal");
          returned = { kind: "refused", refusal };
        }
        requireSame(returned, fixture.expected, `${name} ${fixture.operation}`); assertDurable(returned, subject);
        if (!supported) requireFact(typeof returned === "object" && returned !== null && "kind" in returned && returned.kind === "refused", "unsupported sync");
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
  requireFact(first.kind === "claimed", "store initial claim");
  const replay = await store.claim(fixture.claim);
  requireFact(replay.kind === "claimed" && replay.record.replayed, "store same-key claim replay");
  const attempt = () => store.recordProviderAttempt(fixture.mappedAttemptKey, fixture.claim.fulfillmentRef, fixture.claim.evidence, fixture.claim.mode, "recorded");
  requireFact(!(await attempt()).replayed && (await attempt()).replayed, "G14 same key replays");
  requireFact(fixture.mappedAttemptKey !== fixture.remappedAttemptKey, "G14 remap own key");
  requireFact(fixture.claim.requestKey === fixture.remappedClaim.requestKey && fixture.claim.evidence.commandFingerprint !== fixture.remappedClaim.evidence.commandFingerprint, "draft remap fixture");
  const remap = await store.claim(fixture.remappedClaim);
  requireFact(remap.kind === "claimed", "draft re-claim");
  const row = await store.read(fixture.claim.requestKey);
  requireSame(row?.evidence, fixture.remappedClaim.evidence, "atomic remap fingerprint and evidence");
  assertDurable(row, subject);
  requireFact(!(await store.recordProviderAttempt(fixture.remappedAttemptKey, fixture.claim.fulfillmentRef, fixture.remappedClaim.evidence, fixture.claim.mode, "recorded")).replayed, "G14 new mapped attempt");
  const attempts = await store.readMappedAttempts();
  requireFact(attempts.length === 2, "G14 no duplicate durable attempts");
  requireSame(attempts.map(row => row.attemptKey).sort(), [fixture.mappedAttemptKey, fixture.remappedAttemptKey].sort(), "G14 durable remap identity");
  for (const attempt of attempts) {
    requireSame(attempt.preparedEvidence, dispatchEvidence(attempt.preparedEvidence), "G14 sanitized evidence only");
    assertDurable(attempt, subject);
  }
  const stale = await store.begin({ dispatchRef: row!.dispatchRef, commandFingerprint: fixture.claim.evidence.commandFingerprint });
  requireFact(stale.kind === "refused", "stale prepared command refuses");
  let claims = 0; let calls = 0; let reads = 0;
  const bounded = await runFulfillmentDispatchWorker({
    store: { ...await fixture.create(), async read() { return null; }, async readCandidate() { reads += 1; return reads === 1 ? fixture.request : fixture.remappedRequest; },
      async claim() { claims += 1; return { kind: "refused", refusal: { reason: "contact_stale", phase: "claim", retryable: true } }; } },
    provider: { prepare: request => subject.adapter.dispatch.prepare(request), async dispatch() { calls += 1; throw new Error("unexpected dispatch"); } },
    listCandidates: async () => [fixture.request], config: { mode: "stage", batchLimit: 1 },
    keys: { request: () => fixture.claim.requestKey, mappedAttempt: (_key, index) => index === 0 ? fixture.mappedAttemptKey : fixture.remappedAttemptKey,
      acceptance: () => ({ providerAttemptKey: "fixture-attempt", labelKey: "fixture-label" }) },
  });
  requireFact(claims === 2 && calls === 0 && !bounded.ok, "one-remap limit before I/O");
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

async function checkFull(subject: FulfillmentAdapterTestSubject, dispatchWitnesses: ReadonlyMap<number, DispatchWitness>,
  observe: (index: number) => Promise<NonNullable<Subject["fixtures"]["observation"]>[number]["expected"]>, passed: (operation: string) => void): Promise<void> {
  const kit = subject.certification;
  requireFact(Boolean(kit), "full certification fixtures required");
  requireFact(kit!.profile === "adapter" || kit!.profile === "dispatch-only", "full profile required");
  const { adapter, fixtures } = subject, caps = adapter.capabilities;
  const pair = <T>(rows: readonly T[], success: (row: T) => boolean, failure: (row: T) => boolean, name: string) => {
    requireFact(rows.some(row => success(row)) && rows.some(row => failure(row)), `full ${name} success and failure required`);
  };
  const dispatch = fixtures.dispatch;
  if (caps.operations.dispatch.supported) {
    pair(dispatch, row => row.expectedDispatch?.kind === "accepted", row => row.expectedDispatch?.kind === "not_dispatched", "dispatch");
    requireFact(dispatch.some(row => row.expectedDispatch?.kind === "unknown" && row.replay), "full unknown replay required");
  }
  requireFact(dispatch.some(row => row.expectedPrepare.kind === "refused"), "full preparation refusal required");
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
    requireSame(readFulfillmentCapabilities([caps], selection, request), { kind: "refused", refusal: { reason, phase: "selection", retryable: false } }, `full native ${reason}`);
    if ("operation" in request && request.operation === "reservations") requireSame(readFulfillmentCapabilities([{ ...caps, inventory: { reservationOwner: "provider", consumption: "finished_picking" } }], selection),
      { kind: "refused", refusal: { reason, phase: "selection", retryable: false } }, "full provider-owned reservation declaration");
    requireFact(subject.readIoCount() === before, `full native ${reason} before I/O`);
    passed(`native refusal:${reason}`);
  }
  for (const operation of ["create", "read", "void"] as const) {
    const rows = fixtures.label?.[operation] ?? [];
    requireFact(Boolean(adapter.label) && rows.length > 0, `full label ${operation} refusal fixture required`);
    const supported = caps.operations[operation === "create" ? "labelCreate" : operation === "read" ? "labelRead" : "labelVoid"].supported;
    if (supported) pair(rows.map(row => row.expected), result => "kind" in result ? result.kind === (operation === "read" ? "available" : "created") : result.canProceed,
      result => "refusal" in result && Boolean(result.refusal) && (!("canProceed" in result) || !result.canProceed), `label ${operation}`);
    else requireFact(rows.some(row => "refusal" in row.expected && row.expected.refusal?.reason === "unsupported"), `full label ${operation} explicit refusal`);
  }
  if (caps.operations.dispatch.supported) {
    requireFact(Boolean(kit!.dispatch), "full dispatch scenarios required");
    const scenarios = kit!.dispatch!;
    const before = dispatch[scenarios.addressBeforeSubmission];
    requireFact(before?.expectedPrepare.kind === "refused" && before.expectedPrepare.refusal.reason === "not_dispatchable", "full address before submission");
    requireFact(before.input.lines.length > 0 && before.input.lines.every(line => Boolean(line.skuRef.trim()) && Number.isFinite(line.quantity) && line.quantity > 0)
      && [before.input.recipient.line1, before.input.recipient.city, before.input.recipient.postalCode, before.input.recipient.country].some(value => !value.trim()), "full address invalid with valid items");
    const afterWitness = dispatchWitnesses.get(scenarios.addressAfterSubmission), after = afterWitness?.result;
    requireFact(after?.kind === "not_dispatched" && after.error?.submissionAttempted === true && after.error.mayHaveSucceeded === false, "full address after submission");
    requireFact(afterWitness!.ioDelta > 0, "full address after submission I/O");
    for (const name of ["transport-before-submission", "transport-after-submission", "http-failure"] as const) {
      const fixture = scenarios.transport?.[name], witness = fixture && dispatchWitnesses.get(fixture.fixture), result = witness?.result;
      requireFact(Boolean(witness?.faults.get(name)?.some(call => call.kind === name)), `full ${name} injected fault required for dispatch invocation`);
      requireFact(result?.error !== undefined, `full ${name} error evidence required`);
      const uncertain = name !== "transport-before-submission";
      requireFact(result.kind === (uncertain ? "unknown" : "not_dispatched") && result.error.mayHaveSucceeded === uncertain
        && result.error.submissionAttempted === uncertain, `full ${name} uncertainty`);
      requireFact(uncertain ? witness!.ioDelta > 0 : witness!.ioDelta === 0, `full ${name} submission I/O`);
      if (name === "http-failure") requireFact((result.error.status ?? 0) >= 500, "full HTTP 5xx");
      passed(`adapter transport:${name}`);
    }
  }
  if (caps.operations.verifyObservation.supported) {
    const rows = fixtures.observation ?? [], scenarios = kit!.observation;
    requireFact(Boolean(scenarios), "full observation scenarios required");
    const verified = (index: number) => { const result = rows[index]?.expected; requireFact(result?.kind === "verified", "full verified status required"); return result.observation; };
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
    const auth = rows[scenarios!.authenticationFailure]?.expected;
    requireFact(auth?.kind === "refused" && auth.refusal.reason === "untrusted" && auth.refusal.phase === "verify", "full authentication refusal");
    passed("adapter status:duplicate, out-of-order chronology and authentication refusal");
  }
  if (caps.operations.readback.supported) {
    const rows = fixtures.readback ?? [];
    pair(rows, row => row.expected.kind === "found", row => row.expected.kind === "unknown", "readback");
    requireFact(Boolean(kit!.exceptions), "full exception fixtures required");
    for (const name of ["returned", "lostCoarse"] as const) {
      const result = rows[kit!.exceptions![name]]?.expected;
      requireFact(result?.kind === "found" && result.observation.fact.canonicalStatus === "exception", `full ${name} coarse exception`);
      passed(`adapter exception:${name}`);
    }
    requireFact(rows.some(row => row.expected.kind === "unknown" && row.localMissing), "full unknown versus absent");
    if (caps.operations.exactAbsence.supported) requireFact(rows.some(row => row.expected.kind === "absent"), "full authoritative absence required");
    const pages = kit!.paging;
    requireFact(Boolean(adapter.reconciliation) && Boolean(pages), "full numbered paging fixtures required");
    for (const name of ["full", "short", "empty", "exhausted", "failure"] as const) {
      const fixture = pages![name]; requireFact(Boolean(fixture), `full paging ${name} required`);
      const result = await adapter.reconciliation!.readPage(fixture.input);
      requireSame(result, fixture.expected, `full paging ${name}`); assertDurable(result, subject);
      requireFact(name === "exhausted" ? result.kind === "page_exhausted" : name === "failure" ? result.kind === "failed"
        : result.kind === "page" && (name === "full" ? result.rows.length === fixture.input.size && result.rows.length > 0
          : name === "empty" ? result.rows.length === 0 : result.rows.length > 0 && result.rows.length < fixture.input.size), `full paging ${name} shape`);
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
      requireFact("expected" in row!.success, `full ${name}.${operation} success cannot throw`);
      requireFact("throws" in row!.failure, `full ${name}.${operation} typed failure required`);
      for (const fixture of [row!.success, row!.failure]) {
        let actual: unknown;
        try {
          actual = await (port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[operation]!.apply(port, fixture.input);
        } catch (error) {
          requireFact("throws" in fixture, `full ${operation} unexpected throw`);
          const failure = error as FulfillmentRefusal;
          requireSame({ reason: failure?.reason, phase: failure?.phase, retryable: failure?.retryable }, fixture.throws, `full ${operation} failure`);
          continue;
        }
        requireFact("expected" in fixture, `full ${operation} did not throw`);
        requireSame(actual, fixture.expected, `full ${operation} success`); assertDurable(actual, subject);
      }
      passed(`adapter ${name}.${operation}:success and failure`);
    }
    if (name === "stockSync") {
      const probe = kit!.snapshotOnly;
      requireFact(Boolean(probe), "full snapshot-only refusal probe required");
      const before = probe!.readMovementCalls();
      requireSame(await probe!.invoke(), { reason: "stock_movements_unsupported", phase: "sync", retryable: false }, "full snapshot-only refusal");
      requireFact(probe!.readMovementCalls() === before, "full snapshot-only no movement I/O");
      passed("native refusal:stock_movements_unsupported");
    }
  }
  passed("full:adapter (offline; no durable host qualification)");
}
