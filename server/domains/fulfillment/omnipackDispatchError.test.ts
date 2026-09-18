import { describe, expect, it, vi } from "vitest";
import type {
  OmnipackDispatchCandidate,
  OmnipackDispatchPort,
  OmnipackDispatchReadBack,
} from "./omnipackDispatchContracts.js";
import {
  acceptedProviderProof,
  acknowledgeAcceptedDispatch,
  providerEffectMayHaveSucceeded,
  recoverDispatchAcceptanceWrite,
  safeReason,
  sanitizeDispatchError,
} from "./omnipackDispatchError.js";

describe("OmniPack dispatch error and recovery helpers", () => {
  it.each([
    ["created", "stage", true],
    ["uncertain", "shadow", true],
    ["draft", "shadow", false],
    ["submitting", "live", false],
    ["failed", "stage", false],
  ] as const)(
    "recognizes accepted provider proof for %s/%s as %s",
    (status, dispatchMode, expected) => {
      expect(acceptedProviderProof(readBack({ status, dispatch_mode: dispatchMode }))).toBe(expected);
    },
  );

  it("acknowledges persisted provider proof with deterministic keys and no-POST metadata", async () => {
    const acknowledgeDispatchAcceptance = vi.fn(async () => ({
      dispatchRefId: "dispatch-ref-1",
      fulfillmentOrderId: "fulfillment-1",
      orderId: "order-1",
      providerOrderId: "provider-order-1",
      dispatchStatus: "created" as const,
      fulfillmentStatus: "label_created",
      replayed: false,
    }));
    const port = { acknowledgeDispatchAcceptance } as unknown as OmnipackDispatchPort;
    const persisted = readBack({ provider_order_id: "provider-order-1" }) as OmnipackDispatchReadBack & {
      provider_order_id: string;
    };

    await acknowledgeAcceptedDispatch({
      port,
      candidate: candidate("fulfillment-1"),
      readBack: persisted,
      sanitizedRequest: { provider: "omnipack", itemCount: 2 },
      source: "dispatch_recovery",
    });

    expect(acknowledgeDispatchAcceptance).toHaveBeenCalledWith({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      providerAttemptIdempotencyKey: "omnipack-dispatch:fulfillment-1:provider-accepted",
      labelIdempotencyKey: "omnipack-dispatch:fulfillment-1:label-ack",
      sanitizedRequest: { provider: "omnipack", itemCount: 2 },
      sanitizedResponse: { provider: "omnipack", providerOrderId: "provider-order-1" },
      metadata: {
        source: "dispatch_recovery",
        proof: "persisted_provider_order_id",
        noProviderPost: true,
      },
    });
  });

  it("recovers an ambiguous acceptance write without repeating the provider effect", async () => {
    const readDispatchRefByIdempotencyKey = vi.fn(async () => null);
    const finalizeSubmission = vi.fn(async () => readBack({
      status: "created",
      provider_order_id: "provider-order-1",
    }));
    const result = await recoverDispatchAcceptanceWrite({
      port: { readDispatchRefByIdempotencyKey, finalizeSubmission } as unknown as OmnipackDispatchPort,
      requestIdempotencyKey: "omnipack-dispatch:fulfillment-1",
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      sanitizedResponse: { providerOrderId: "provider-order-1" },
      error: new Error("database connection reset"),
    });

    expect(result).toEqual({ committed: true, readBacks: 1 });
    expect(finalizeSubmission).toHaveBeenCalledWith(expect.objectContaining({
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      mayHaveSucceeded: true,
      error: expect.objectContaining({
        code: "omnipack_dispatch_acceptance_write_failed",
        mayHaveSucceeded: true,
        retryable: false,
      }),
    }));
  });

  it("uses a committed read-back as the recovery fence and tolerates a failed repair write", async () => {
    const finalizeCommitted = vi.fn();
    await expect(recoverDispatchAcceptanceWrite({
      port: {
        readDispatchRefByIdempotencyKey: vi.fn(async () => readBack({
          status: "created",
          provider_order_id: "provider-order-1",
        })),
        finalizeSubmission: finalizeCommitted,
      } as unknown as OmnipackDispatchPort,
      requestIdempotencyKey: "key",
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      sanitizedResponse: {},
      error: new Error("late error"),
    })).resolves.toEqual({ committed: true, readBacks: 1 });
    expect(finalizeCommitted).not.toHaveBeenCalled();

    await expect(recoverDispatchAcceptanceWrite({
      port: {
        readDispatchRefByIdempotencyKey: vi.fn(async () => null),
        finalizeSubmission: vi.fn(async () => {
          throw new Error("write unavailable");
        }),
      } as unknown as OmnipackDispatchPort,
      requestIdempotencyKey: "key",
      dispatchRefId: "dispatch-ref-1",
      providerOrderId: "provider-order-1",
      sanitizedResponse: {},
      error: new Error("late error"),
    })).resolves.toEqual({ committed: false, readBacks: 0 });
  });

  it("sanitizes provider failures while failing closed for unknown post-boundary errors", () => {
    const definiteFailure = {
      provider: "omnipack",
      code: "validation_failed",
      status: 400,
      retryable: false,
      mayHaveSucceeded: false,
    };
    expect(safeReason(definiteFailure)).toBe("omnipack_provider_create_order_non_retryable:validation_failed");
    expect(providerEffectMayHaveSucceeded(definiteFailure)).toBe(false);
    expect(sanitizeDispatchError(definiteFailure)).toMatchObject({
      code: "validation_failed",
      retryable: false,
      mayHaveSucceeded: false,
      status: 400,
    });

    const unknown = new Error("response parser failed after a possible 2xx");
    expect(providerEffectMayHaveSucceeded(unknown)).toBe(true);
    expect(sanitizeDispatchError(unknown)).toEqual({
      code: "Error",
      message: "response parser failed after a possible 2xx",
      retryable: true,
      mayHaveSucceeded: true,
      status: null,
    });
  });
});

function candidate(fulfillmentOrderId: string): OmnipackDispatchCandidate {
  return {
    fulfillmentOrderId,
    orderId: `order-${fulfillmentOrderId}`,
    orderNumber: `OPENLUP-${fulfillmentOrderId}`,
    status: "created",
    deliveryContact: {
      schemaVersion: 1,
      source: "legacy_inferred",
      revision: 1,
      recipientName: null,
      contactEmail: null,
      contactPhone: null,
      line1: "",
      line2: null,
      city: "",
      postalCode: "",
      country: "",
      selectedDelivery: null,
      deliveryInstructions: null,
      courierInstructions: null,
    },
    client: { email: null, firstName: null, lastName: null, phone: null },
    shippingAddress: { label: null, recipientName: null, line1: "", city: "", postalCode: "", country: "" },
    deliverySelection: null,
    lines: [],
  };
}

function readBack(overrides: Partial<OmnipackDispatchReadBack> = {}): OmnipackDispatchReadBack {
  return {
    id: "dispatch-ref-1",
    fulfillment_order_id: "fulfillment-1",
    order_id: "order-1",
    provider_order_id: "provider-order-1",
    dispatch_mode: "stage",
    status: "created",
    request_idempotency_key: "omnipack-dispatch:fulfillment-1",
    sanitized_request: { provider: "omnipack" },
    ...overrides,
  };
}
