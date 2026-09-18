import { describe, expect, it } from "vitest";
import { parseNormalizedFulfillmentFact } from "../src/fulfillment/index.js";

describe("fulfillment standalone entrypoint", () => {
  it("lets an adopter supply its canonical status predicate", () => {
    const fact = parseNormalizedFulfillmentFact({
      schemaVersion: 1,
      mapperVersion: "warehouse@1",
      factId: "fact-1",
      providerKind: "warehouse",
      fulfillmentReference: "fulfillment-1",
      canonicalStatus: "warehouse_received",
      provenance: { source: "provider_response", authority: "provider_asserted" },
      occurredAt: null,
      receivedAt: "2026-07-10T10:00:00.000Z",
      rawEvent: {
        reference: "evidence:123e4567-e89b-42d3-a456-426614174001",
        digestAlgorithm: "sha256",
        digest: "a".repeat(64),
      },
    }, {
      isCanonicalStatus: (value): value is "warehouse_received" => value === "warehouse_received",
    });
    expect(fact.canonicalStatus).toBe("warehouse_received");
  });
});
