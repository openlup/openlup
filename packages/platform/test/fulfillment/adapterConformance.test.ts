import { expect, it } from "vitest";
import type { FulfillmentAdapterConformanceSubject as Subject, FulfillmentDispatchResult, FulfillmentReadbackResult, FulfillmentRefusal } from "../../src/fulfillment/contracts/index.js";
import { runFulfillmentAdapterConformance as run } from "../../src/fulfillment/index.js";
import { at, memoryStore, observation, profile, request } from "./fixtures.js";

function subject(full: boolean): Subject {
  let calls = 0;
  const prepared = new Map<string, string>(), responses = new Map<string, FulfillmentDispatchResult>();
  const unsupported = (phase: FulfillmentRefusal["phase"]): FulfillmentRefusal => ({ reason: "unsupported", phase, retryable: false });
  const evidence = (input = request()) => ({ commandFingerprint: `actual:${input.requestKey}:${input.contactRevision.revision}`, contactRevision: input.contactRevision, providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a" });
  const accepted = (input = request()): FulfillmentDispatchResult => ({ kind: "accepted", externalRef: "external-a", evidence: evidence(input), providerAttemptKey: "legacy-attempt", labelKey: "legacy-label" });
  const readInput = (kind: string) => ({ providerRef: "warehouse-a", requestKey: kind, fulfillmentRef: "fulfillment-a", externalRef: "external-a", mode: "command" as const });
  const readResult = (kind: string): FulfillmentReadbackResult => {
    if (!full || kind === "unsupported") return { kind: "unsupported", refusal: unsupported("readback") };
    if (kind === "absent") { const { mode: _mode, ...scope } = readInput(kind); return { kind: "absent", scope, proof: { kind: "authoritative_exact_lookup", evidenceRef: "evidence:exact-a", checkedAt: at } }; }
    if (kind === "unknown" || kind === "missing") return { kind: "unknown", refusal: { reason: kind === "missing" ? "local_missing" : "io_failure", phase: "readback", retryable: kind !== "missing" } };
    return { kind: "found", externalRef: "external-a", createdAt: null, updatedAt: at, observation: observation() };
  };
  const input = request(); const document = { objectRef: "label-a", mediaType: "application/pdf" as const, externalRef: "external-a" };
  const s: Subject = {
    subjectId: full ? "full-fixture" : "minimal-fixture", adapter: {
      capabilities: profile(full),
      dispatch: {
        async prepare(value) {
          if (!value.selection.providerRef) return { kind: "refused", refusal: { reason: "selection_required", phase: "selection", retryable: false } };
          if (!value.lines.length) return { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } };
          const proof = evidence(value); prepared.set(proof.commandFingerprint, JSON.stringify(value)); return { kind: "prepared", evidence: proof };
        },
        async dispatch(value, proof) {
          if (prepared.get(proof.commandFingerprint) !== JSON.stringify(value)) return { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } };
          if (responses.has(value.requestKey)) return responses.get(value.requestKey)!;
          calls += 1;
          const result: FulfillmentDispatchResult = value.requestKey === "unknown" ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }
            : value.requestKey === "refused" ? { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } } : accepted(value);
          responses.set(value.requestKey, result); return result;
        },
      },
      label: { async create() { return full ? { kind: "created", parcelRef: "parcel-a", document } : { kind: "refused", refusal: unsupported("dispatch") }; },
        async read() { return full ? { kind: "available", url: "https://storage.example.invalid/?signature=fixture-signed-url", expiresAt: at } : { kind: "refused", refusal: unsupported("readback") }; },
        async void() { return full ? { providerDeletion: "confirmed", labelDeleted: true, canProceed: true } : { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: unsupported("dispatch") }; } },
      readback: { async read(value) { return readResult(value.requestKey); } },
    }, readIoCount: () => calls, sensitiveValues: ["fixture-secret", "fixture-body", "fixture-signed-url", "fixture-credential"],
    fixtures: { dispatch: [
      { input, expectedPrepare: { kind: "prepared", evidence: evidence(input) }, expectedDispatch: accepted(input), replay: true },
      { input: { ...input, lines: [] }, expectedPrepare: { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } } },
    ],
    label: { create: [{ input: [input], expected: full ? { kind: "created", parcelRef: "parcel-a", document } : { kind: "refused", refusal: unsupported("dispatch") } }],
      read: [{ input: [document], expected: full ? { kind: "available", url: "https://storage.example.invalid/?signature=fixture-signed-url", expiresAt: at } : { kind: "refused", refusal: unsupported("readback") } }],
      void: [{ input: [{ parcelRef: "parcel-a", document }], expected: full ? { providerDeletion: "confirmed", labelDeleted: true, canProceed: true } : { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: false, refusal: unsupported("dispatch") } }] },
    readback: (full ? ["found", "absent", "unknown", "missing", "unsupported"] : ["unsupported"]).map(kind => ({ input: [readInput(kind)], expected: readResult(kind), ...(kind === "missing" ? { localMissing: true } : {}) })),
    },
  };
  if (full) {
    const unknown = { ...input, requestKey: "unknown" }, refused = { ...input, requestKey: "refused" };
    s.fixtures.dispatch = [...s.fixtures.dispatch, { input: unknown, expectedPrepare: { kind: "prepared", evidence: evidence(unknown) }, expectedDispatch: { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }, replay: true },
      { input: refused, expectedPrepare: { kind: "prepared", evidence: evidence(refused) }, expectedDispatch: { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } } }];
    s.adapter.observation = { async verifyAndNormalize(value) {
      if (value.headers.authorization !== "fixture-secret") return { kind: "refused", refusal: { reason: "untrusted", phase: "verify", retryable: false } };
      const status = new TextDecoder().decode(value.rawBody) === "delivered" ? "delivered" : "in_transit";
      return { kind: "verified", observation: observation(status, value.receivedAt) };
    } };
    s.fixtures.observation = ["in_transit", "delivered", "in_transit"].map((status, i) => {
      const receivedAt = `2026-10-21T1${i}:00:00.000Z`;
      return { input: [{ rawBody: new TextEncoder().encode(status), headers: { authorization: "fixture-secret" }, receivedAt }], expected: { kind: "verified", observation: observation(status === "delivered" ? "delivered" : "in_transit", receivedAt) } };
    });
    s.adapter.stockSync = { async getStock() { return []; }, async getStockMovements() { return []; } };
    s.fixtures.stockSync = [{ operation: "getStock", input: [], expected: [] }, { operation: "getStockMovements", input: [{ size: 2 }], expected: [] }];
    s.adapter.productSync = { async ensureProduct() { return null; }, async getProductPacks() { return []; }, async addProductPack() {}, async listStockedSkus() { return []; } };
    s.fixtures.productSync = [{ operation: "ensureProduct", input: ["skip"], expected: null }, { operation: "getProductPacks", input: ["sku-a"], expected: [] },
      { operation: "addProductPack", input: ["sku-a", { ean: "ean-a", quantity: 1 }], expected: undefined }, { operation: "listStockedSkus", input: [], expected: [] }];
    s.store = { create: async () => memoryStore(), claim: { requestKey: input.requestKey, fulfillmentRef: input.fulfillmentRef, orderRef: input.orderRef, parcelRef: null, mode: "stage", evidence: evidence(input) },
      remappedClaim: { requestKey: input.requestKey, fulfillmentRef: input.fulfillmentRef, orderRef: input.orderRef, parcelRef: null, mode: "stage", evidence: evidence(request(2)) },
      mappedAttemptKey: "legacy-mapped", remappedAttemptKey: "legacy-remapped", request: input, remappedRequest: request(2) };
  }
  return s;
}

it("proves full and minimal offline fixture adapters plus G14/store reclaim/remap without returning transient material", async () => {
  const evidence = await run([subject(true), subject(false)]);
  expect(evidence.subjects.map(s => s.subjectId)).toEqual(["full-fixture", "minimal-fixture"]);
  expect(evidence.cases).toContainEqual({ subjectId: "full-fixture", operation: "store G14 replay, own-key remap and one-remap bound", passed: true });
  expect(evidence.cases.some(c => c.operation === "readback absent")).toBe(true);
  expect(evidence.cases.some(c => c.operation.startsWith("dispatch unknown"))).toBe(true);
  expect(JSON.stringify(evidence)).not.toMatch(/fixture-secret|fixture-body|fixture-signed-url|fixture-credential/);
});

it("rejects mismatched preparation I/O, leaked durable fields, false absence and outcome-key collisions", async () => {
  const mismatch = subject(false); const dispatch = mismatch.adapter.dispatch.dispatch;
  mismatch.adapter.dispatch.dispatch = async (input, proof) => proof.commandFingerprint.endsWith(":mismatch") ? { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } } : dispatch(input, proof);
  await expect(run([mismatch])).rejects.toThrow("mismatched preparation refusal");
  const leak = subject(false); const prepare = leak.adapter.dispatch.prepare;
  leak.adapter.dispatch.prepare = async input => { const result = await prepare(input); if (result.kind === "prepared") Object.assign(result.evidence, { rawBody: "fixture-body" }); return result; };
  Object.assign(leak.fixtures.dispatch[0].expectedPrepare.kind === "prepared" && leak.fixtures.dispatch[0].expectedPrepare.evidence, { rawBody: "fixture-body" });
  await expect(run([leak])).rejects.toThrow("durable secret redaction");
  const absence = subject(true); absence.adapter.capabilities.operations = { ...absence.adapter.capabilities.operations, exactAbsence: { supported: false, reason: "not_exposed" } };
  await expect(run([absence])).rejects.toThrow("unsupported exact absence");
  const collision = subject(true); const verify = collision.adapter.observation!.verifyAndNormalize;
  collision.adapter.observation!.verifyAndNormalize = async input => { const result = await verify(input); if (result.kind === "verified") result.observation.eventKey = "provider-id-only"; return result; };
  for (const row of collision.fixtures.observation!) if (row.expected.kind === "verified") row.expected.observation.eventKey = "provider-id-only";
  await expect(run([collision])).rejects.toThrow("eventKey includes outcome and occurrence");
});
