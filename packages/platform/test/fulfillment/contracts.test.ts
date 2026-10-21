import { expect, expectTypeOf, it } from "vitest";
import * as contracts from "../../src/fulfillment/contracts/index.js";
import type { FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentStorePort, FulfillmentLabelPort } from "../../src/fulfillment/contracts/index.js";
import { parseFulfillmentFact, parseFulfillmentTransitionConflict } from "../../src/fulfillment/index.js";

it("isolates browser types, nullable pre-create parcels, actual-command proof and transient label responses (G1–G5)", () => {
  expect(Object.keys(contracts)).toEqual([]);
  expectTypeOf<FulfillmentDispatchRequest["parcelRef"]>().toEqualTypeOf<string | null>();
  expectTypeOf<FulfillmentDispatchRequest["contactRevision"]>().toEqualTypeOf<{ schemaVersion: number; source: string; revision: number }>();
  type Record = NonNullable<Awaited<ReturnType<FulfillmentStorePort["read"]>>>;
  expectTypeOf<Record["evidence"]>().not.toHaveProperty("url");
  expectTypeOf<Record["evidence"]>().not.toHaveProperty("recipient");
  expectTypeOf<Record>().not.toHaveProperty("rawBody");
  expectTypeOf<Record["evidence"]>().toHaveProperty("commandFingerprint");
  expectTypeOf<Extract<FulfillmentDispatchResult, { kind: "not_dispatched" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<false>();
  expectTypeOf<Extract<FulfillmentDispatchResult, { kind: "unknown" }>["effectMayHaveSucceeded"]>().toEqualTypeOf<true>();
  type Created = Extract<Awaited<ReturnType<FulfillmentLabelPort["create"]>>, { kind: "created" }>;
  expectTypeOf<Created["document"]>().toBeNullable();
  expectTypeOf<NonNullable<Created["document"]>>().not.toHaveProperty("url");
  const cleanup: Awaited<ReturnType<FulfillmentLabelPort["void"]>> = { providerDeletion: "unconfirmed", labelDeleted: false, canProceed: true };
  expect(cleanup).toEqual({ providerDeletion: "unconfirmed", labelDeleted: false, canProceed: true });
});

it("binds strict core fact and conflict parsers to the contributed status canon", () => {
  const fact = { schemaVersion: 1, mapperVersion: "private-v1", factId: "event-a", providerKind: "warehouse-a", fulfillmentReference: "remote-a", canonicalStatus: "picking", provenance: { source: "provider_webhook", authority: "provider_asserted" }, occurredAt: null, receivedAt: "2026-10-21T10:00:00Z", rawEvent: { reference: "evidence:00000000-0000-4000-8000-000000000001", digestAlgorithm: "sha256", digest: "a".repeat(64) } };
  expect(parseFulfillmentFact(fact)).toEqual(fact);
  expect(() => parseFulfillmentFact({ ...fact, canonicalStatus: "private_state" })).toThrow();
  expect(() => parseFulfillmentFact({ ...fact, password: "synthetic-secret" })).toThrow();
  expect(() => parseFulfillmentFact({ ...fact, rawEvent: { ...fact.rawEvent, url: "https://example.invalid/?signed=synthetic" } })).toThrow();
  expect(() => parseFulfillmentTransitionConflict({})).toThrow();
});
