import type { FulfillmentAdapterConformanceEvidence, FulfillmentAdapterConformanceSubject, FulfillmentRefusal } from "./contracts/index.js";
import { dispatchEvidence, dispatchResult } from "./dispatchProjection.js";
import { projectObservation } from "./observationProjection.js";
import { readFulfillmentCapabilities } from "./providerCapabilities.js";
import { runFulfillmentDispatchWorker } from "./providerDispatchWorker.js";

type Subject = FulfillmentAdapterConformanceSubject;
/** Runner-independent offline proof using only adapter-owned fixtures. Throws on a violated contract. */
export async function runFulfillmentAdapterConformance(subjects: readonly FulfillmentAdapterConformanceSubject[]): Promise<FulfillmentAdapterConformanceEvidence> {
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
    const missing = await adapter.dispatch.prepare({ ...first.input, selection: { ...first.input.selection, providerRef: null } });
    requireFact(missing.kind === "refused" && missing.refusal.reason === "selection_required", "adapter selection_required");
    passed("default-off and selection_required");
    for (const fixture of fixtures.dispatch) {
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
      const result = await adapter.dispatch.dispatch(fixture.input, prepared.evidence);
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
        if (!supported && !(operation === "read" && caps.labelReadOwner === "host_storage")) {
          requireFact("refusal" in result && result.refusal?.reason === "unsupported", `unsupported label ${operation}`);
          requireFact(subject.readIoCount() === before, "unsupported label before I/O");
        }
        if (!(operation === "read" && "kind" in result && result.kind === "available")) assertDurable(result, subject);
        passed(`label ${operation}`);
      }
    }
    if (caps.operations.verifyObservation.supported) requireFact(Boolean(adapter.observation) && Boolean(fixtures.observation?.length), "observation fixtures required");
    const events = new Map<string, { identity: string; occurredAt: string | null }>();
    for (const fixture of fixtures.observation ?? []) {
      requireFact(Boolean(adapter.observation), "observation port required");
      const result = await adapter.observation!.verifyAndNormalize(...fixture.input);
      requireSame(result, fixture.expected, "observation fixture"); assertDurable(result, subject);
      if (!caps.operations.verifyObservation.supported) requireFact(result.kind === "refused" && result.refusal.reason === "unsupported", "unsupported observation");
      if (result.kind === "verified") {
        requireSame(result.observation, projectObservation(result.observation, subject.approveTrackingUrl), "observation allowlist");
        const observation = result.observation;
        const identity = stable({ provider: observation.fact.providerKind, reference: observation.fact.fulfillmentReference,
          kind: observation.eventKind, outcome: observation.fact.canonicalStatus, occurredAt: observation.fact.occurredAt });
        const previous = events.get(observation.eventKey);
        if (previous) requireFact(previous.identity === identity, "eventKey includes outcome and occurrence");
        events.set(observation.eventKey, { identity, occurredAt: observation.fact.occurredAt });
        const replay = await adapter.observation!.verifyAndNormalize(...fixture.input);
        requireSame(replay, result, "observation exact retry");
      }
      passed("observation identity, replay and redaction");
    }
    if (caps.operations.readback.supported) requireFact(Boolean(adapter.readback) && Boolean(fixtures.readback?.length), "readback fixtures required");
    for (const fixture of fixtures.readback ?? []) {
      requireFact(Boolean(adapter.readback), "readback port required");
      const result = await adapter.readback!.read(...fixture.input);
      requireSame(result, fixture.expected, "readback fixture"); assertDurable(result, subject);
      if (!caps.operations.readback.supported) requireFact(result.kind === "unsupported", "unsupported readback");
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
        passed(`${name} ${fixture.operation}`);
      }
    }
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
