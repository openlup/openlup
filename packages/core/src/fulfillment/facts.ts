import { z } from "zod";

/** @beta */ export const NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION = 1 as const;
/** @beta */ export const NORMALIZED_FULFILLMENT_FACT_PREVIOUS_SCHEMA_VERSION = 0 as const;
/** @beta */ export const PROVIDER_FULFILLMENT_FACT_SOURCES = [
  "provider_webhook",
  "provider_reconciliation",
  "provider_response",
] as const;
/** @beta */ export const FULFILLMENT_FACT_SOURCES = [
  ...PROVIDER_FULFILLMENT_FACT_SOURCES,
  "operator_repair",
] as const;
/** @beta */ export const FULFILLMENT_FACT_SOURCE_AUTHORITIES = [
  "provider_asserted",
  "operator_asserted",
] as const;
/** @beta */ export type ProviderFulfillmentFactSource =
  (typeof PROVIDER_FULFILLMENT_FACT_SOURCES)[number];
/** @beta */ export type FulfillmentFactSource = (typeof FULFILLMENT_FACT_SOURCES)[number];
/** @beta */ export type FulfillmentFactSourceAuthority =
  (typeof FULFILLMENT_FACT_SOURCE_AUTHORITIES)[number];
/** @beta */ export type FulfillmentFactProvenance =
  | { readonly source: ProviderFulfillmentFactSource; readonly authority: "provider_asserted" }
  | { readonly source: "operator_repair"; readonly authority: "operator_asserted" };

/**
 * Pointer to separately governed raw evidence. The reference is minted by the
 * adopting application (`evidence:<uuid>`), never copied from provider,
 * tracking, customer, or order data. PII safety still belongs to that minting
 * boundary and the referenced evidence store; this contract only enforces the
 * namespace and identifier shape.
 */
/** @beta */ export interface FulfillmentRawEventReference {
  readonly reference: `evidence:${string}`;
  readonly digestAlgorithm: "sha256";
  readonly digest: string;
}

/** Comparable only within one provider + fulfillment reference sequence. */
/** @beta */ export interface FulfillmentProviderSequence {
  readonly kind: "monotonic_ordinal";
  readonly ordinal: number;
}

interface NormalizedFulfillmentFactFields<TCanonicalStatus extends string> {
  readonly mapperVersion: string;
  readonly factId: string;
  readonly providerKind: string;
  readonly fulfillmentReference: string;
  readonly canonicalStatus: TCanonicalStatus;
  readonly provenance: FulfillmentFactProvenance;
  readonly occurredAt: string | null;
  readonly receivedAt: string;
  readonly providerSequence?: FulfillmentProviderSequence;
}

/** Provider-neutral evidence; it authorizes no transition or external effect. */
/** @beta */ export interface NormalizedFulfillmentFactV1<TCanonicalStatus extends string = string>
  extends NormalizedFulfillmentFactFields<TCanonicalStatus> {
  readonly schemaVersion: typeof NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION;
  readonly rawEvent: FulfillmentRawEventReference;
}

/** @beta */ export type NormalizedFulfillmentFact<TCanonicalStatus extends string = string> =
  NormalizedFulfillmentFactV1<TCanonicalStatus>;

/** Narrow legacy wire shape supported only for deterministic N-1 ingestion. */
/** @beta */ export interface NormalizedFulfillmentFactV0<TCanonicalStatus extends string = string>
  extends NormalizedFulfillmentFactFields<TCanonicalStatus> {
  readonly schemaVersion: typeof NORMALIZED_FULFILLMENT_FACT_PREVIOUS_SCHEMA_VERSION;
  readonly rawEventReference: `evidence:${string}`;
  readonly rawEventSha256: string;
}

/** @beta */ export type CompatibleNormalizedFulfillmentFact<TCanonicalStatus extends string = string> =
  | NormalizedFulfillmentFactV0<TCanonicalStatus>
  | NormalizedFulfillmentFactV1<TCanonicalStatus>;
/** @beta */ export interface FulfillmentFactParserOptions<TCanonicalStatus extends string> {
  isCanonicalStatus(value: string): value is TCanonicalStatus;
}

const nonEmpty = z.string().trim().min(1);
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const evidenceReference = z.string().regex(
  /^evidence:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  "must be an application-minted evidence:<uuid> reference",
);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const rfc3339 = z.iso.datetime({ offset: true });
const providerProvenance = z.object({
  source: z.enum(PROVIDER_FULFILLMENT_FACT_SOURCES),
  authority: z.literal("provider_asserted"),
}).strict();
const operatorProvenance = z.object({
  source: z.literal("operator_repair"),
  authority: z.literal("operator_asserted"),
}).strict();
const provenance = z.union([providerProvenance, operatorProvenance]);
const providerSequence = z.object({
  kind: z.literal("monotonic_ordinal"),
  ordinal: z.number().int().nonnegative().safe(),
}).strict();
const commonFields = {
  mapperVersion: nonEmpty,
  factId: opaqueId,
  providerKind: opaqueId,
  fulfillmentReference: opaqueId,
  canonicalStatus: nonEmpty,
  provenance,
  occurredAt: rfc3339.nullable(),
  receivedAt: rfc3339,
  providerSequence: providerSequence.optional(),
} as const;
const v1Schema = z.object({
  schemaVersion: z.literal(NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION),
  ...commonFields,
  rawEvent: z.object({
    reference: evidenceReference,
    digestAlgorithm: z.literal("sha256"),
    digest: sha256,
  }).strict(),
}).strict();
const v0Schema = z.object({
  schemaVersion: z.literal(NORMALIZED_FULFILLMENT_FACT_PREVIOUS_SCHEMA_VERSION),
  ...commonFields,
  rawEventReference: evidenceReference,
  rawEventSha256: sha256,
}).strict();

/** @beta */ export class InvalidFulfillmentFactError extends Error {
  constructor(readonly reason: string) {
    super(`invalid_fulfillment_fact:${reason}`);
    this.name = "InvalidFulfillmentFactError";
  }
}

/** @beta */ export class UnsupportedFulfillmentFactSchemaError extends Error {
  constructor(readonly schemaVersion: unknown) {
    super(`unsupported_fulfillment_fact_schema:${String(schemaVersion)}`);
    this.name = "UnsupportedFulfillmentFactSchemaError";
  }
}

/** Strict public unknown-input boundary for current N and supported N-1. */
/** @beta */ export function parseNormalizedFulfillmentFact<TCanonicalStatus extends string>(
  value: unknown,
  options: FulfillmentFactParserOptions<TCanonicalStatus>,
): NormalizedFulfillmentFact<TCanonicalStatus> {
  const version = value && typeof value === "object"
    ? (value as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  const schema = version === NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION
    ? v1Schema
    : version === NORMALIZED_FULFILLMENT_FACT_PREVIOUS_SCHEMA_VERSION
      ? v0Schema
      : null;
  if (!schema) throw new UnsupportedFulfillmentFactSchemaError(version);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidFulfillmentFactError(parsed.error.issues[0]?.message ?? "schema");
  if (!options.isCanonicalStatus(parsed.data.canonicalStatus)) {
    throw new InvalidFulfillmentFactError("canonical_status_unknown");
  }
  if (parsed.data.schemaVersion === NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION) {
    return parsed.data as NormalizedFulfillmentFact<TCanonicalStatus>;
  }
  const { rawEventReference, rawEventSha256, ...shared } = parsed.data;
  return {
    ...shared,
    schemaVersion: NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION,
    canonicalStatus: parsed.data.canonicalStatus,
    rawEvent: {
      reference: rawEventReference,
      digestAlgorithm: "sha256",
      digest: rawEventSha256,
    },
  } as NormalizedFulfillmentFact<TCanonicalStatus>;
}

/** Stable property-order-independent identity of one already parsed fact. */
/** @beta */ export function canonicalFulfillmentFactFingerprint(
  fact: NormalizedFulfillmentFact,
): string {
  return JSON.stringify([
    fact.schemaVersion,
    fact.mapperVersion,
    fact.factId,
    fact.providerKind,
    fact.fulfillmentReference,
    fact.canonicalStatus,
    fact.provenance.source,
    fact.provenance.authority,
    fact.occurredAt,
    fact.receivedAt,
    fact.providerSequence?.kind ?? null,
    fact.providerSequence?.ordinal ?? null,
    fact.rawEvent.reference,
    fact.rawEvent.digestAlgorithm,
    fact.rawEvent.digest,
  ]);
}

/** @beta */ export class FulfillmentFactCollisionError extends Error {
  constructor(readonly factId: string) {
    super(`fulfillment_fact_id_collision:${factId}`);
    this.name = "FulfillmentFactCollisionError";
  }
}

/** Deterministic exact-duplicate collapse; conflicting reuse fails closed. */
/** @beta */ export function canonicalizeFulfillmentFacts<TCanonicalStatus extends string>(
  facts: readonly NormalizedFulfillmentFact<TCanonicalStatus>[],
): NormalizedFulfillmentFact<TCanonicalStatus>[] {
  const byId = new Map<string, { fact: NormalizedFulfillmentFact<TCanonicalStatus>; fingerprint: string }>();
  for (const fact of facts) {
    const fingerprint = canonicalFulfillmentFactFingerprint(fact);
    const existing = byId.get(fact.factId);
    if (existing && existing.fingerprint !== fingerprint) throw new FulfillmentFactCollisionError(fact.factId);
    byId.set(fact.factId, { fact, fingerprint });
  }
  return [...byId.values()]
    .sort((left, right) => left.fact.factId.localeCompare(right.fact.factId))
    .map(({ fact }) => fact);
}

/** @beta */ export const TRANSITION_CONFLICT_REASONS = [
  "status_regression",
  "terminal_status_disagreement",
  "provider_sequence_regression",
  "source_authority_disagreement",
] as const;
/** @beta */ export type TransitionConflictReason = (typeof TRANSITION_CONFLICT_REASONS)[number];

/** @beta */ export interface FulfillmentTransitionSnapshot<TCanonicalStatus extends string = string> {
  readonly fact: NormalizedFulfillmentFact<TCanonicalStatus>;
}

/** @beta */ export type TransitionConflictDecision =
  | { readonly kind: "selected"; readonly selected: "current" | "incoming"; readonly reasonCode: string }
  | { readonly kind: "hold"; readonly reasonCode: string };

/** Self-contained immutable diagnostic emitted by a future consumer reducer. */
/** @beta */ export interface TransitionConflict<TCanonicalStatus extends string = string> {
  readonly conflictId: `conflict:${string}`;
  readonly policyVersion: string;
  readonly reason: TransitionConflictReason;
  readonly fulfillmentReference: string;
  readonly current: FulfillmentTransitionSnapshot<TCanonicalStatus>;
  readonly incoming: FulfillmentTransitionSnapshot<TCanonicalStatus>;
  readonly decision: TransitionConflictDecision;
  readonly detectedAt: string;
}

const conflictReference = z.string().regex(
  /^conflict:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  "must be an application-minted conflict:<uuid> reference",
);
const transitionConflictEnvelope = z.object({
  conflictId: conflictReference,
  policyVersion: nonEmpty,
  reason: z.enum(TRANSITION_CONFLICT_REASONS),
  fulfillmentReference: opaqueId,
  current: z.object({ fact: z.unknown() }).strict(),
  incoming: z.object({ fact: z.unknown() }).strict(),
  decision: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("selected"),
      selected: z.enum(["current", "incoming"]),
      reasonCode: opaqueId,
    }).strict(),
    z.object({ kind: z.literal("hold"), reasonCode: opaqueId }).strict(),
  ]),
  detectedAt: rfc3339,
}).strict();

/** @beta */ export function parseTransitionConflict<TCanonicalStatus extends string>(
  value: unknown,
  options: FulfillmentFactParserOptions<TCanonicalStatus>,
): TransitionConflict<TCanonicalStatus> {
  const envelope = transitionConflictEnvelope.safeParse(value);
  if (!envelope.success) {
    throw new InvalidFulfillmentFactError(
      `transition_conflict:${envelope.error.issues[0]?.message ?? "schema"}`,
    );
  }
  const current = parseNormalizedFulfillmentFact(envelope.data.current.fact, options);
  const incoming = parseNormalizedFulfillmentFact(envelope.data.incoming.fact, options);
  if (current.providerKind !== incoming.providerKind
    || current.fulfillmentReference !== incoming.fulfillmentReference
    || envelope.data.fulfillmentReference !== current.fulfillmentReference) {
    throw new InvalidFulfillmentFactError("transition_conflict_stream_mismatch");
  }
  return {
    ...envelope.data,
    conflictId: envelope.data.conflictId as `conflict:${string}`,
    decision: envelope.data.decision!,
    current: { fact: current },
    incoming: { fact: incoming },
  };
}
