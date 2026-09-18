import { describe, expect, it } from "vitest";
import {
  FulfillmentFactCollisionError,
  InvalidFulfillmentFactError,
  UnsupportedFulfillmentFactSchemaError,
  canonicalFulfillmentFactFingerprint,
  canonicalizeFulfillmentFacts,
  parseNormalizedFulfillmentFact,
  parseTransitionConflict,
  type NormalizedFulfillmentFact,
} from "../src/fulfillment/index.js";

type Status = "accepted" | "delivered";
const options = {
  isCanonicalStatus: (value: string): value is Status => value === "accepted" || value === "delivered",
};
const evidenceId = (suffix: string) => `evidence:123e4567-e89b-42d3-a456-4266141740${suffix}` as const;

const accepted: NormalizedFulfillmentFact<Status> = {
  schemaVersion: 1,
  mapperVersion: "example-status@2",
  factId: "fact-accepted",
  providerKind: "example-3pl",
  fulfillmentReference: "fulfillment-1",
  canonicalStatus: "accepted",
  provenance: { source: "provider_webhook", authority: "provider_asserted" },
  occurredAt: "2026-07-10T10:00:00.000Z",
  receivedAt: "2026-07-10T10:00:01.000+00:00",
  providerSequence: { kind: "monotonic_ordinal", ordinal: 100 },
  rawEvent: { reference: evidenceId("01"), digestAlgorithm: "sha256", digest: "a".repeat(64) },
};

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [Array.from(values)];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

describe("normalized fulfillment fact contract", () => {
  it("strictly parses N and upgrades strict N-1", () => {
    expect(parseNormalizedFulfillmentFact(accepted, options)).toEqual(accepted);
    const previous = {
      ...accepted,
      schemaVersion: 0,
      rawEventReference: accepted.rawEvent.reference,
      rawEventSha256: accepted.rawEvent.digest,
    } as Record<string, unknown>;
    delete previous.rawEvent;
    expect(parseNormalizedFulfillmentFact(previous, options)).toEqual(accepted);
  });

  it("rejects unsupported versions, unknown statuses, unknown keys and malformed fields", () => {
    expect(() => parseNormalizedFulfillmentFact({ ...accepted, schemaVersion: 99 }, options))
      .toThrow(UnsupportedFulfillmentFactSchemaError);
    for (const invalid of [
      { ...accepted, canonicalStatus: "provider_private" },
      { ...accepted, unexpected: true },
      { ...accepted, mapperVersion: " " },
      { ...accepted, occurredAt: "yesterday" },
      { ...accepted, receivedAt: "2026-07-10" },
      { ...accepted, providerSequence: { kind: "opaque", ordinal: 1 } },
      { ...accepted, providerSequence: { kind: "monotonic_ordinal", ordinal: -1 } },
      { ...accepted, rawEvent: { ...accepted.rawEvent, digestAlgorithm: "md5" } },
      { ...accepted, rawEvent: { ...accepted.rawEvent, digest: "payload" } },
      { ...accepted, rawEvent: { ...accepted.rawEvent, reference: "provider-order:123" } },
    ]) {
      expect(() => parseNormalizedFulfillmentFact(invalid, options)).toThrow(InvalidFulfillmentFactError);
    }
  });

  it("makes invalid provenance combinations unrepresentable and rejects them at runtime", () => {
    expect(() => parseNormalizedFulfillmentFact({
      ...accepted,
      provenance: { source: "operator_repair", authority: "provider_asserted" },
    }, options)).toThrow(InvalidFulfillmentFactError);
    expect(() => parseNormalizedFulfillmentFact({
      ...accepted,
      provenance: { source: "provider_webhook", authority: "operator_asserted" },
    }, options)).toThrow(InvalidFulfillmentFactError);
  });

  it("is permutation invariant, collapses exact duplicates, and fails on collisions", () => {
    const delivered: NormalizedFulfillmentFact<Status> = {
      ...accepted,
      factId: "fact-delivered",
      canonicalStatus: "delivered",
      providerSequence: { kind: "monotonic_ordinal", ordinal: 200 },
      rawEvent: { ...accepted.rawEvent, reference: evidenceId("02"), digest: "b".repeat(64) },
    };
    const expected = canonicalizeFulfillmentFacts([accepted, delivered]);
    for (const ordering of permutations([accepted, delivered, accepted])) {
      expect(canonicalizeFulfillmentFacts(ordering)).toEqual(expected);
    }
    expect(() => canonicalizeFulfillmentFacts([accepted, { ...accepted, canonicalStatus: "delivered" }]))
      .toThrow(FulfillmentFactCollisionError);
  });

  it("fingerprints explicit fields independently from object property order", () => {
    const reordered = {
      rawEvent: accepted.rawEvent,
      receivedAt: accepted.receivedAt,
      occurredAt: accepted.occurredAt,
      provenance: accepted.provenance,
      canonicalStatus: accepted.canonicalStatus,
      fulfillmentReference: accepted.fulfillmentReference,
      providerKind: accepted.providerKind,
      factId: accepted.factId,
      mapperVersion: accepted.mapperVersion,
      providerSequence: accepted.providerSequence,
      schemaVersion: accepted.schemaVersion,
    } satisfies NormalizedFulfillmentFact<Status>;
    expect(canonicalFulfillmentFactFingerprint(reordered))
      .toBe(canonicalFulfillmentFactFingerprint(accepted));
  });

  it("parses only self-consistent transition conflict evidence", () => {
    const incoming = {
      ...accepted,
      factId: "fact-delivered",
      canonicalStatus: "delivered" as const,
      rawEvent: { ...accepted.rawEvent, reference: evidenceId("02"), digest: "b".repeat(64) },
    };
    const conflict = {
      conflictId: "conflict:123e4567-e89b-42d3-a456-426614174003",
      policyVersion: "precedence@1",
      reason: "status_regression",
      fulfillmentReference: accepted.fulfillmentReference,
      current: { fact: accepted },
      incoming: { fact: incoming },
      decision: { kind: "selected", selected: "incoming", reasonCode: "newer_ordinal" },
      detectedAt: "2026-07-10T10:00:02.000Z",
    };
    expect(parseTransitionConflict(conflict, options).decision)
      .toEqual({ kind: "selected", selected: "incoming", reasonCode: "newer_ordinal" });
    for (const invalid of [
      { ...conflict, fulfillmentReference: "another-fulfillment" },
      { ...conflict, incoming: { fact: { ...incoming, providerKind: "another-provider" } } },
      { ...conflict, decision: { kind: "selected", selected: "neither", reasonCode: "bad" } },
      { ...conflict, conflictId: "conflict-1" },
      { ...conflict, detectedAt: "yesterday" },
    ]) {
      expect(() => parseTransitionConflict(invalid, options)).toThrow(InvalidFulfillmentFactError);
    }
  });
});
