import {
  canonicalStatusToken,
  customerStepFromSignals,
  stepForToken,
  type CustomerFulfillmentStep,
} from "../domains/fulfillment/statusMap.js";

export {
  FULFILLMENT_STATUS_MAP,
  // The canon's token->step and step->label readers. Re-exported here because
  // this module is the documented cross-domain seam: src/domains/commerce must
  // not import src/domains/fulfillment internals directly, which
  // architectureGuardrails enforces.
  stepForToken,
  timelineLabelForStep,
  type CustomerFulfillmentStep,
} from "../domains/fulfillment/statusMap.js";

export interface TimedFulfillmentSignal {
  id?: string | null | undefined;
  token: string | null | undefined;
  occurredAt: string | null | undefined;
}

/** Server-only shape read from a released automatic provider-exception hold. */
export interface ReleasedProviderExceptionHold {
  orderId: string | null | undefined;
  status: string | null | undefined;
  reason: string | null | undefined;
  createdBy: string | null | undefined;
  releasedBy: string | null | undefined;
  metadata: unknown;
}

export interface ProviderStatusEvidence extends TimedFulfillmentSignal {
  fulfillmentOrderId: string | null | undefined;
  providerStatus: string | null | undefined;
  localStatus: string | null | undefined;
}

export interface ResolvedProviderExceptionRecovery {
  clearedExceptionEvidenceIds: ReadonlySet<string>;
  recoveryEvidenceIds: ReadonlySet<string>;
}

const AUTOMATIC_EXCEPTION_HOLD_SOURCE = "commerce.fulfillment.omnipack_provider_exception";
const AUTOMATIC_EXCEPTION_RELEASE_SOURCE = "commerce.fulfillment.omnipack_provider_exception_healed";

/**
 * Finds only database-authored, trigger-created recovery links. The returned IDs
 * stay server-side: the browser receives the resulting Layer C step, never hold
 * metadata or provider evidence identifiers.
 */
export function resolveProviderExceptionRecovery(input: {
  fulfillmentOrderId: string | null | undefined;
  releasedHolds: ReleasedProviderExceptionHold[];
  statusEvidence: ProviderStatusEvidence[];
}): ResolvedProviderExceptionRecovery {
  const clearedExceptionEvidenceIds = new Set<string>();
  const recoveryEvidenceIds = new Set<string>();
  const fulfillmentOrderId = text(input.fulfillmentOrderId);
  if (!fulfillmentOrderId) return { clearedExceptionEvidenceIds, recoveryEvidenceIds };

  const evidenceById = new Map(
    input.statusEvidence
      .map((row) => [text(row.id), row] as const)
      .filter(([id]) => Boolean(id)),
  );

  for (const hold of input.releasedHolds) {
    if (
      hold.status !== "released"
      || hold.reason !== "fulfillment_exception"
      || hold.createdBy !== null
      || hold.releasedBy !== null
    ) {
      continue;
    }
    const metadata = record(hold.metadata);
    const recovery = record(metadata.autoReleaseEvidence);
    if (
      metadata.source !== AUTOMATIC_EXCEPTION_HOLD_SOURCE
      || metadata.autoReleased !== true
      || metadata.autoReleaseSource !== AUTOMATIC_EXCEPTION_RELEASE_SOURCE
      || (metadata.autoReleaseProof !== "provider_recovered" && metadata.autoReleaseProof !== "delivered")
      || recovery.fulfillmentOrderId !== fulfillmentOrderId
    ) {
      continue;
    }

    const cleared = evidenceById.get(text(recovery.clearedStatusEvidenceId));
    const recovered = evidenceById.get(text(recovery.statusEvidenceId));
    if (!cleared || !recovered || text(cleared.fulfillmentOrderId) !== fulfillmentOrderId || text(recovered.fulfillmentOrderId) !== fulfillmentOrderId) {
      continue;
    }

    const clearedStatus = canonicalStatusToken(cleared.providerStatus);
    const recoveryStatus = canonicalStatusToken(recovered.localStatus);
    if (
      canonicalStatusToken(cleared.localStatus) !== "exception"
      || (clearedStatus !== "suspended" && clearedStatus !== "shipping_failed")
      || !sameInstant(recovery.clearedOccurredAt, cleared.occurredAt)
      || !sameInstant(recovery.occurredAt, recovered.occurredAt)
      || !isStrictlyNewer(recovered.occurredAt, cleared.occurredAt)
      || canonicalStatusToken(text(recovery.clearedProviderStatus)) !== clearedStatus
      || canonicalStatusToken(text(recovery.localStatus)) !== recoveryStatus
      || !isApprovedRecovery(clearedStatus, recoveryStatus, metadata.autoReleaseProof)
    ) {
      continue;
    }

    const clearedId = text(cleared.id);
    const recoveredId = text(recovered.id);
    if (!clearedId || !recoveredId) continue;
    clearedExceptionEvidenceIds.add(clearedId);
    recoveryEvidenceIds.add(recoveredId);
  }

  return { clearedExceptionEvidenceIds, recoveryEvidenceIds };
}

/**
 * The customer step for an order that is terminal BY OUR OWN DECISION
 * (`cancelled` / `refunded`), or `null` when normal rank resolution applies.
 *
 * Rank alone is not enough here: `delivered` (7) outranks `cancelled` (6), so a
 * single provider `DELIVERED` evidence row on an order we cancelled would tell
 * the customer "Dostarczono". Carrier evidence is a fact and stays recorded, but
 * it cannot un-cancel our own order, so the terminal order status wins.
 *
 * This is a ceiling, not a new opinion: `delivered` is the ONLY step ranking
 * above `cancelled`, and the order's own status already contributes `cancelled`
 * to the ranked signals, so every non-delivered outcome is unchanged. The canon's
 * ranks stay untouched — they are shared with OMS health, observability and the
 * admin timeline, where provider-versus-local divergence must remain visible.
 * Single owner of this rule: the customer read model and the browser fallback
 * resolver both call it instead of each keeping a copy.
 */
export function customerStepForTerminalOrder(
  orderStatus: string | null | undefined,
): CustomerFulfillmentStep | null {
  return stepForToken(orderStatus) === "cancelled" ? "cancelled" : null;
}

/** Resolve rank normally; only a uniquely newer canonical timed exception may cover delivered. */
export function customerStepFromTimedSignals(
  baseTokens: Array<string | null | undefined>,
  evidence: TimedFulfillmentSignal[],
  recovery?: ResolvedProviderExceptionRecovery,
): CustomerFulfillmentStep {
  const recovered = recovery?.clearedExceptionEvidenceIds.size;
  const effectiveBaseTokens = recovered
    ? baseTokens.filter((token) => stepForToken(token) !== "exception")
    : baseTokens;
  const effectiveEvidence = recovery
    ? evidence.filter((signal) => !recovery.clearedExceptionEvidenceIds.has(text(signal.id)))
    : evidence;
  const ranked = customerStepFromSignals([...effectiveBaseTokens, ...effectiveEvidence.map((signal) => signal.token)]);
  if (ranked !== "delivered") return ranked;
  const timedOccurrences = effectiveEvidence
    .map((signal) => ({ step: stepForToken(signal.token), time: validTimestamp(signal.occurredAt) }))
    .filter((signal): signal is { step: CustomerFulfillmentStep | null; time: number } => signal.time !== null);
  const timed = [...new Map(timedOccurrences.map((signal) => [
    `${signal.step ?? "unknown"}:${signal.time}`,
    signal,
  ])).values()];
  const latestTime = Math.max(...timed.map((signal) => signal.time));
  const latest = timed.filter((signal) => signal.time === latestTime);
  const deliveryTimes = timed.filter((signal) => signal.step === "delivered").map((signal) => signal.time);
  const latestDeliveryTime = deliveryTimes.length ? Math.max(...deliveryTimes) : null;
  return latest.length === 1 && latest[0].step === "exception"
    && latestDeliveryTime !== null && latestTime > latestDeliveryTime ? "exception" : ranked;
}

/** Keep legacy/provider-only OmniPack CANCELLED evidence customer-safe. */
export function customerSafeEvidenceToken(
  localStatus: string | null | undefined,
  providerStatus: string | null | undefined,
): string | null {
  const local = canonicalStatusToken(localStatus);
  const provider = canonicalStatusToken(providerStatus);
  if (provider === "cancelled" && (local === null || local === "cancelled")) return "exception";
  return local ?? provider;
}

function validTimestamp(value: string | null | undefined): number | null {
  if (!value || !/(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isApprovedRecovery(
  clearedStatus: "suspended" | "shipping_failed",
  recoveryStatus: string | null,
  proof: unknown,
): boolean {
  if (proof === "delivered") return recoveryStatus === "delivered";
  return clearedStatus === "suspended"
    && proof === "provider_recovered"
    && ["provider_received", "picking", "packed", "in_transit"].includes(recoveryStatus ?? "");
}

function isStrictlyNewer(candidate: string | null | undefined, previous: string | null | undefined): boolean {
  const candidateTime = validTimestamp(candidate);
  const previousTime = validTimestamp(previous);
  return candidateTime !== null && previousTime !== null && candidateTime > previousTime;
}

function sameInstant(metadataValue: unknown, evidenceValue: string | null | undefined): boolean {
  if (typeof metadataValue !== "string") return false;
  const metadataTime = validTimestamp(metadataValue);
  const evidenceTime = validTimestamp(evidenceValue);
  return metadataTime !== null && evidenceTime !== null && metadataTime === evidenceTime;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
