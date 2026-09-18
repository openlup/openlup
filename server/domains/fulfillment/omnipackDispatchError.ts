import { omnipackDispatchAcceptanceKeys } from "./omnipackDispatchAcceptance.js";
import type {
  OmnipackDispatchCandidate,
  OmnipackDispatchPort,
  OmnipackDispatchReadBack,
} from "./omnipackDispatchContracts.js";

export function acceptedProviderProof(
  readBack: OmnipackDispatchReadBack | null,
): readBack is OmnipackDispatchReadBack & { provider_order_id: string } {
  return Boolean(
    readBack?.provider_order_id
      && (
        readBack.status === "created"
        || readBack.status === "uncertain"
      ),
  );
}

export async function acknowledgeAcceptedDispatch(input: {
  port: OmnipackDispatchPort;
  candidate: OmnipackDispatchCandidate;
  readBack: OmnipackDispatchReadBack & { provider_order_id: string };
  sanitizedRequest: Record<string, unknown>;
  source: string;
}) {
  const providerOrderId = input.readBack.provider_order_id;
  const acceptanceKeys = omnipackDispatchAcceptanceKeys(input.candidate.fulfillmentOrderId);
  return input.port.acknowledgeDispatchAcceptance({
    dispatchRefId: input.readBack.id,
    providerOrderId,
    ...acceptanceKeys,
    sanitizedRequest: input.sanitizedRequest,
    sanitizedResponse: { provider: "omnipack", providerOrderId },
    metadata: {
      source: input.source,
      proof: "persisted_provider_order_id",
      noProviderPost: true,
    },
  });
}

export async function recoverDispatchAcceptanceWrite(input: {
  port: OmnipackDispatchPort;
  requestIdempotencyKey: string;
  dispatchRefId: string;
  providerOrderId: string;
  sanitizedResponse: Record<string, unknown>;
  error: unknown;
}): Promise<{ committed: boolean; readBacks: number }> {
  let readBack = await input.port.readDispatchRefByIdempotencyKey(input.requestIdempotencyKey).catch(() => null);
  let readBacks = readBack ? 1 : 0;
  if (dispatchAcceptanceCommitted(readBack, input.providerOrderId)) return { committed: true, readBacks };

  try {
    readBack = await input.port.finalizeSubmission({
      dispatchRefId: input.dispatchRefId,
      providerOrderId: input.providerOrderId,
      mayHaveSucceeded: true,
      sanitizedResponse: input.sanitizedResponse,
      error: {
        code: "omnipack_dispatch_acceptance_write_failed",
        message: safeReason(input.error),
        retryable: false,
        mayHaveSucceeded: true,
        status: null,
      },
    });
    readBacks += 1;
  } catch {
    // The durable row remains submitting. The stale-submission sweep moves it
    // to uncertain; neither state is eligible for another provider POST.
  }
  return { committed: dispatchAcceptanceCommitted(readBack, input.providerOrderId), readBacks };
}

export function safeReason(error: unknown): string {
  const providerError = providerErrorEvidence(error);
  if (providerError?.mayHaveSucceeded) {
    return `omnipack_provider_create_order_uncertain:${providerError.code}`;
  }
  if (providerError && !providerError.retryable) {
    return `omnipack_provider_create_order_non_retryable:${providerError.code}`;
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export function sanitizeDispatchError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const providerError = providerErrorEvidence(error);
  const retryable = providerError?.retryable ?? !message.startsWith("omnipack_order_payload_");
  // This sanitizer is only used after createOrder was invoked. An unknown error
  // can therefore be an HTTP 2xx followed by malformed response parsing (or any
  // other response-boundary failure), so absence of structured provider evidence
  // must fail closed as ambiguous rather than contradicting the `uncertain` row.
  const mayHaveSucceeded = providerError?.mayHaveSucceeded ?? true;
  return {
    code: providerError?.code ?? (error instanceof Error ? error.name : "omnipack_provider_error"),
    message: message.slice(0, 180),
    retryable,
    mayHaveSucceeded,
    status: providerError?.status ?? null,
  };
}

export function providerEffectMayHaveSucceeded(error: unknown): boolean {
  return providerErrorEvidence(error)?.mayHaveSucceeded ?? true;
}

function dispatchAcceptanceCommitted(readBack: OmnipackDispatchReadBack | null, providerOrderId: string): boolean {
  return readBack?.status === "created" && readBack.provider_order_id === providerOrderId;
}

function providerErrorEvidence(error: unknown): {
  code: string;
  mayHaveSucceeded: boolean;
  retryable: boolean;
  status: number | null;
} | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.provider !== "string" || record.provider !== "omnipack") return null;
  if (typeof record.code !== "string" || typeof record.retryable !== "boolean") return null;
  const status = typeof record.status === "number" ? record.status : null;
  return {
    code: record.code,
    mayHaveSucceeded: typeof record.mayHaveSucceeded === "boolean"
      ? record.mayHaveSucceeded
      : status === null || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500,
    retryable: record.retryable,
    status,
  };
}
