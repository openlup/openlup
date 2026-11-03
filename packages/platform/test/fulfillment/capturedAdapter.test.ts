import { expect, it } from "vitest";
import { createCapturedFulfillmentAdapter, runFulfillmentAdapterConformance } from "../../src/fulfillment/index.js";
import type { DispatchEvidence, FulfillmentAdapterConformanceSubject, FulfillmentDispatchResult } from "../../src/fulfillment/contracts/index.js";
import { request } from "./fixtures.js";

const fingerprints = {
  "legacy-request-a": "16d2b4609da4b2dc83f3bd7668aecad400a7dd0436ac3bf7099f81ba804e3bad",
  unknown: "eabbe526e4ce4ff4441e69d9d9b214d0e98c7e8875fa344bed9ce76f4e2579e7",
  refused: "424fcff6d149b10ac2498a20356db11e13418f1e1863b61ec73f46068dcdcec9",
};
const evidence = (key: keyof typeof fingerprints): DispatchEvidence => ({ commandFingerprint: fingerprints[key],
  contactRevision: { schemaVersion: 1, source: "contact", revision: 1 }, providerRef: "warehouse-a", carrierRef: "carrier-a", serviceRef: "service-a" });
const accepted: FulfillmentDispatchResult = { kind: "accepted", externalRef: "external-a", evidence: evidence("legacy-request-a"),
  providerAttemptKey: `captured-attempt:${fingerprints["legacy-request-a"]}`, labelKey: `captured-receipt:${fingerprints["legacy-request-a"]}` };
const captures = () => [
  { request: request(), outcome: { kind: "accepted" as const, externalRef: "external-a" } },
  { request: { ...request(), requestKey: "unknown" }, outcome: { kind: "unknown" as const } },
  { request: { ...request(), requestKey: "refused" }, outcome: { kind: "not_dispatched" as const } },
];

it("passes offline adapter conformance with accepted, refused and unknown replay, without PII in proof", async () => {
  const adapter = createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", selected: true, captures: captures() });
  const subject: FulfillmentAdapterConformanceSubject = { subjectId: "captured-fulfillment", adapter,
    readIoCount: adapter.readSubmissionCount, sensitiveValues: ["Synthetic 1", "Example"], fixtures: { dispatch: [
      { input: request(), expectedPrepare: { kind: "prepared", evidence: evidence("legacy-request-a") }, expectedDispatch: accepted, replay: true },
      { input: { ...request(), requestKey: "unknown" }, expectedPrepare: { kind: "prepared", evidence: evidence("unknown") },
        expectedDispatch: { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } }, replay: true },
      { input: { ...request(), requestKey: "refused" }, expectedPrepare: { kind: "prepared", evidence: evidence("refused") },
        expectedDispatch: { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } }, replay: true },
      { input: { ...request(), lines: [] }, expectedPrepare: { kind: "refused", refusal: { reason: "not_dispatchable", phase: "prepare", retryable: false } } },
    ] } };
  const proof = await runFulfillmentAdapterConformance([subject]);
  expect(proof.subjects).toEqual([{ subjectId: "captured-fulfillment", providerRef: "warehouse-a" }]);
  expect(proof.cases).toHaveLength(5);
  expect(adapter.readSubmissionCount()).toBe(3);
  expect(JSON.stringify(proof)).not.toMatch(/Synthetic 1|Example/);
});

it("is default-off, requires prior preparation and refuses changes to command bytes or evidence", async () => {
  const off = createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", captures: captures() });
  expect(await off.dispatch.prepare(request())).toMatchObject({ kind: "refused", refusal: { reason: "disabled" } });
  const adapter = createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", selected: true, captures: captures() });
  const noSubmission = { kind: "not_dispatched", effectMayHaveSucceeded: false, refusal: { reason: "not_dispatchable", phase: "dispatch", retryable: false } };
  expect(await adapter.dispatch.dispatch(request(), evidence("legacy-request-a"))).toEqual(noSubmission);
  await adapter.dispatch.prepare(request());
  for (const changed of [
    { ...request(), recipient: { ...request().recipient, line1: "Different 2" } },
    { ...request(), contactRevision: { ...request().contactRevision, revision: 2 } },
    { ...request(), lines: [{ ...request().lines[0]!, quantity: 2 }] },
    { ...request(), orderRef: "other-order" },
  ]) {
    expect(await adapter.dispatch.prepare(changed)).toMatchObject({ kind: "refused" });
    expect(await adapter.dispatch.dispatch(changed, evidence("legacy-request-a"))).toEqual(noSubmission);
  }
  expect(await adapter.dispatch.dispatch(request(), { ...evidence("legacy-request-a"), providerRef: "other" })).toEqual(noSubmission);
  expect(adapter.readSubmissionCount()).toBe(0);
  expect(await adapter.dispatch.dispatch(request(), evidence("legacy-request-a"))).toEqual(accepted);
  expect(adapter.readSubmissionCount()).toBe(1);
  for (const [operation, declared] of Object.entries(adapter.capabilities.operations)) {
    expect(declared.supported).toBe(operation === "dispatch");
  }
});

it("freezes captures and returned proof, rejects duplicates and unsafe durable identities", async () => {
  const input = captures();
  const adapter = createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", selected: true, captures: input });
  input[0]!.request.recipient.line1 = "Later mutation";
  const prepared = await adapter.dispatch.prepare(request());
  expect(prepared).toEqual({ kind: "prepared", evidence: evidence("legacy-request-a") });
  if (prepared.kind !== "prepared") throw new Error("expected preparation");
  prepared.evidence.contactRevision.revision = 99;
  const first = await adapter.dispatch.dispatch(request(), evidence("legacy-request-a"));
  if (first.kind !== "accepted") throw new Error("expected acceptance");
  first.externalRef = "mutated";
  expect(await adapter.dispatch.dispatch(request(), evidence("legacy-request-a"))).toEqual(accepted);
  expect(() => createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", captures: [captures()[0]!, captures()[0]!] })).toThrow("captured_fulfillment_command_invalid");
  expect(() => createCapturedFulfillmentAdapter({ providerRef: "user@example.invalid", captures: [] })).toThrow("captured_fulfillment_provider_invalid");
  expect(() => createCapturedFulfillmentAdapter({ providerRef: "warehouse-a", captures: [{ request: request(), outcome: { kind: "accepted", externalRef: "https://example.invalid/?token=secret" } }] })).toThrow("captured_fulfillment_command_invalid");
});
