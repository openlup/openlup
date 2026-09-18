import { describe, expect, it } from "vitest";
import {
  CANONICAL_LOCAL_FULFILLMENT_STATUSES,
  FULFILLMENT_STATUS_MAP,
} from "./statusMap";
import {
  InvalidFulfillmentFactError,
  canonicalizeFulfillmentFacts,
  isCanonicalLocalFulfillmentStatus,
  parseAppNormalizedFulfillmentFact,
  parseAppTransitionConflict,
  type NormalizedFulfillmentFact,
  type TransitionConflict,
} from "./normalizedFulfillmentFacts";

const receivedInput = {
  schemaVersion: 1,
  mapperVersion: "provider-status@2",
  factId: "fact-received",
  providerKind: "example-3pl",
  fulfillmentReference: "fulfillment-1",
  canonicalStatus: "provider_received",
  provenance: { source: "provider_webhook", authority: "provider_asserted" },
  occurredAt: "2026-07-10T10:00:00.000Z",
  receivedAt: "2026-07-10T10:00:01.000Z",
  providerSequence: { kind: "monotonic_ordinal", ordinal: 100 },
  rawEvent: {
    reference: "evidence:123e4567-e89b-42d3-a456-426614174001",
    digestAlgorithm: "sha256",
    digest: "a".repeat(64),
  },
} as const;

describe("openlup normalized fulfillment facts", () => {
  it("derives its accepted statuses from the existing Layer B canon", () => {
    const mapped = new Set(FULFILLMENT_STATUS_MAP.stages.flatMap((stage) => stage.localStatus));
    expect(new Set(CANONICAL_LOCAL_FULFILLMENT_STATUSES)).toEqual(mapped);
    for (const status of CANONICAL_LOCAL_FULFILLMENT_STATUSES) {
      expect(isCanonicalLocalFulfillmentStatus(status)).toBe(true);
    }
    expect(isCanonicalLocalFulfillmentStatus("provider_private_status")).toBe(false);
  });

  it("binds the public unknown parser to the existing status canon", () => {
    const received = parseAppNormalizedFulfillmentFact(receivedInput);
    expect(received.canonicalStatus).toBe("provider_received");
    expect(() => parseAppNormalizedFulfillmentFact({
      ...receivedInput,
      canonicalStatus: "provider_private_status",
    })).toThrow(InvalidFulfillmentFactError);
  });

  it("uses parsed immutable facts in deterministic dedupe and conflicts", () => {
    const received = parseAppNormalizedFulfillmentFact(receivedInput);
    const delivered = parseAppNormalizedFulfillmentFact({
      ...receivedInput,
      factId: "fact-delivered",
      canonicalStatus: "delivered",
      providerSequence: { kind: "monotonic_ordinal", ordinal: 200 },
      rawEvent: {
        ...receivedInput.rawEvent,
        reference: "evidence:123e4567-e89b-42d3-a456-426614174002",
        digest: "b".repeat(64),
      },
    });
    expect(canonicalizeFulfillmentFacts([delivered, received, delivered]))
      .toEqual([delivered, received]);

    const conflict: TransitionConflict = parseAppTransitionConflict({
      conflictId: "conflict:123e4567-e89b-42d3-a456-426614174003",
      policyVersion: "fulfillment-precedence@1",
      reason: "status_regression",
      fulfillmentReference: received.fulfillmentReference,
      current: { fact: delivered },
      incoming: { fact: received },
      decision: { kind: "hold", reasonCode: "operator_review_required" },
      detectedAt: "2026-07-10T12:00:02.000Z",
    });
    expect(conflict.current.fact).toMatchObject({
      mapperVersion: "provider-status@2",
      canonicalStatus: "delivered",
      providerSequence: { ordinal: 200 },
    });
    expect(conflict.decision.kind).toBe("hold");
    expect(() => parseAppTransitionConflict({
      ...conflict,
      incoming: { fact: { ...received, providerKind: "other-provider" } },
    })).toThrow("transition_conflict_stream_mismatch");
  });

  it("keeps fact types narrowed to the canonical status union", () => {
    const fact: NormalizedFulfillmentFact = parseAppNormalizedFulfillmentFact(receivedInput);
    expect(fact.canonicalStatus).toBe("provider_received");
  });
});
