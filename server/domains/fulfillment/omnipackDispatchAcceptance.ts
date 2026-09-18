export interface OmnipackDispatchAcceptanceInput {
  dispatchRefId: string;
  providerOrderId: string | null;
  providerAttemptIdempotencyKey: string;
  labelIdempotencyKey: string;
  sanitizedProviderProof: Record<string, unknown>;
}

export interface OmnipackDispatchAcceptanceResult {
  dispatchRefId: string;
  fulfillmentOrderId: string;
  orderId: string;
  providerOrderId: string;
  dispatchStatus: "created";
  fulfillmentStatus: string;
  replayed: boolean;
}

export function omnipackDispatchAcceptanceKeys(fulfillmentOrderId: string): {
  providerAttemptIdempotencyKey: string;
  labelIdempotencyKey: string;
} {
  const prefix = `omnipack-dispatch:${fulfillmentOrderId}`;
  return {
    providerAttemptIdempotencyKey: `${prefix}:provider-accepted`,
    labelIdempotencyKey: `${prefix}:label-ack`,
  };
}

export function parseOmnipackDispatchAcceptanceResult(
  data: unknown,
  invalidReason: string,
): OmnipackDispatchAcceptanceResult {
  const row = (data ?? {}) as Record<string, unknown>;
  if (
    typeof row.dispatchRefId !== "string"
    || typeof row.fulfillmentOrderId !== "string"
    || typeof row.orderId !== "string"
    || typeof row.providerOrderId !== "string"
    || !row.providerOrderId.trim()
    || row.dispatchStatus !== "created"
    || typeof row.fulfillmentStatus !== "string"
  ) {
    throw new Error(invalidReason);
  }
  return {
    dispatchRefId: row.dispatchRefId,
    fulfillmentOrderId: row.fulfillmentOrderId,
    orderId: row.orderId,
    providerOrderId: row.providerOrderId.trim(),
    dispatchStatus: row.dispatchStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    replayed: row.replayed === true,
  };
}
