export type OmnipackReconciliationWriteOperation = "provider_stock_consumed";

export type OmnipackReconciliationDomainReason =
  | "commerce_fulfillment_not_found"
  | "commerce_fulfillment_provider_stock_consumed_requires_label"
  | "commerce_fulfillment_provider_stock_consumed_invalid_input";

const KNOWN_REASONS = new Set<OmnipackReconciliationDomainReason>([
  "commerce_fulfillment_not_found",
  "commerce_fulfillment_provider_stock_consumed_requires_label",
  "commerce_fulfillment_provider_stock_consumed_invalid_input",
]);

const MANUAL_REVIEW_REASONS = new Set<OmnipackReconciliationDomainReason>([
  "commerce_fulfillment_not_found",
  "commerce_fulfillment_provider_stock_consumed_requires_label",
]);

export class OmnipackReconciliationWriteError extends Error {
  constructor(
    readonly operation: OmnipackReconciliationWriteOperation,
    readonly code: string,
    readonly domainReason: OmnipackReconciliationDomainReason | null,
  ) {
    super(`omnipack_reconciliation_${operation}_write_failed:${code}:${domainReason ?? "unclassified"}`);
    this.name = "OmnipackReconciliationWriteError";
  }
}

export function omnipackReconciliationWriteError(
  operation: OmnipackReconciliationWriteOperation,
  error: { code?: string; message?: string },
): OmnipackReconciliationWriteError {
  return new OmnipackReconciliationWriteError(
    operation,
    error.code ?? "unknown",
    knownReason(error.message),
  );
}

export function isOmnipackReconciliationManualReviewError(
  error: unknown,
): error is OmnipackReconciliationWriteError & { domainReason: OmnipackReconciliationDomainReason } {
  return error instanceof OmnipackReconciliationWriteError &&
    error.domainReason !== null &&
    MANUAL_REVIEW_REASONS.has(error.domainReason);
}

export async function quarantineOmnipackReconciliationStateConflict(
  error: unknown,
  recordId: string,
  fulfilment: OmnipackReconciliationFulfilment,
  recordQuarantine: OmnipackReconciliationPort["recordQuarantine"],
  result: OmnipackReconciliationResult,
): Promise<unknown | null> {
  if (!isOmnipackReconciliationManualReviewError(error)) return error;
  try {
    const quarantine = await recordQuarantine({
      idempotencyKey: `omnipack-reconciliation:${recordId}:state-conflict:${error.domainReason}`,
      fulfilment,
      reason: `omnipack_reconciliation_state_conflict:${error.domainReason}`,
    });
    if (quarantine.replayed) result.replayed += 1;
    result.quarantined += quarantine.replayed ? 0 : 1;
    result.stateConflicts += 1;
    return null;
  } catch (quarantineError) {
    return quarantineError;
  }
}

function knownReason(message: string | undefined): OmnipackReconciliationDomainReason | null {
  const value = message?.trim() as OmnipackReconciliationDomainReason | undefined;
  return value && KNOWN_REASONS.has(value) ? value : null;
}
import type {
  OmnipackReconciliationFulfilment,
  OmnipackReconciliationPort,
  OmnipackReconciliationResult,
} from "./omnipackReconciliationWorker.js";
