import { expect, it } from "vitest";
import { parseFulfillmentFact, parseFulfillmentTransitionConflict } from "../src/fulfillment/index.js";

it("binds strict core fact and conflict parsers to the contributed status canon", () => {
  const fact = { schemaVersion: 1, mapperVersion: "private-v1", factId: "event-a", providerKind: "warehouse-a", fulfillmentReference: "remote-a", canonicalStatus: "picking", provenance: { source: "provider_webhook", authority: "provider_asserted" }, occurredAt: null, receivedAt: "2026-10-21T10:00:00Z", rawEvent: { reference: "evidence:00000000-0000-4000-8000-000000000001", digestAlgorithm: "sha256", digest: "a".repeat(64) } };
  expect(parseFulfillmentFact(fact)).toEqual(fact);
  expect(() => parseFulfillmentFact({ ...fact, canonicalStatus: "private_state" })).toThrow();
  expect(() => parseFulfillmentFact({ ...fact, password: "synthetic-secret" })).toThrow();
  expect(() => parseFulfillmentFact({ ...fact, rawEvent: { ...fact.rawEvent, url: "https://example.invalid/?signed=synthetic" } })).toThrow();
  expect(() => parseFulfillmentTransitionConflict({})).toThrow();
});
