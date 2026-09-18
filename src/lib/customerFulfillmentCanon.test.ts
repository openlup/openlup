import { describe, expect, it } from "vitest";
import {
  customerStepForTerminalOrder,
  customerStepFromTimedSignals,
  resolveProviderExceptionRecovery,
} from "./customerFulfillmentCanon.js";

const fulfillmentOrderId = "fulfillment-1";
const exceptionAt = "2026-08-04T10:00:00.000Z";
const recoveryAt = "2026-08-04T10:01:00.000Z";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "exception-evidence",
    fulfillmentOrderId,
    providerStatus: "SUSPENDED",
    localStatus: "exception",
    token: "exception",
    occurredAt: exceptionAt,
    ...overrides,
  };
}

function recoveryMetadata(overrides: Record<string, unknown> = {}) {
  const evidenceOverrides = overrides.autoReleaseEvidence as Record<string, unknown> | undefined;
  return {
    source: "commerce.fulfillment.omnipack_provider_exception",
    autoReleased: true,
    autoReleaseSource: "commerce.fulfillment.omnipack_provider_exception_healed",
    autoReleaseProof: "provider_recovered",
    ...overrides,
    autoReleaseEvidence: {
      fulfillmentOrderId,
      statusEvidenceId: "recovery-evidence",
      providerStatus: "AWAITING_COURIER",
      localStatus: "packed",
      occurredAt: recoveryAt,
      clearedStatusEvidenceId: "exception-evidence",
      clearedProviderStatus: "SUSPENDED",
      clearedOccurredAt: exceptionAt,
      ...evidenceOverrides,
    },
  };
}

function hold(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-1",
    status: "released",
    reason: "fulfillment_exception",
    createdBy: null,
    releasedBy: null,
    metadata: recoveryMetadata(),
    ...overrides,
  };
}

describe("provider exception recovery projection", () => {
  it("clears only an exactly linked suspended exception and resolves packed recovery", () => {
    const statusEvidence = [
      evidence(),
      evidence({
        id: "recovery-evidence",
        providerStatus: "AWAITING_COURIER",
        localStatus: "packed",
        token: "packed",
        occurredAt: recoveryAt,
      }),
    ];
    const recovery = resolveProviderExceptionRecovery({
      fulfillmentOrderId,
      releasedHolds: [hold()],
      statusEvidence,
    });

    expect(recovery.clearedExceptionEvidenceIds).toEqual(new Set(["exception-evidence"]));
    expect(recovery.recoveryEvidenceIds).toEqual(new Set(["recovery-evidence"]));
    expect(customerStepFromTimedSignals(["paid", "exception"], statusEvidence, recovery)).toBe("packing");
  });

  it("allows suspended provider_received recovery but requires delivery for shipping_failed", () => {
    const providerReceived = [
      evidence(),
      evidence({
        id: "recovery-evidence",
        providerStatus: "NEW",
        localStatus: "provider_received",
        token: "provider_received",
        occurredAt: recoveryAt,
      }),
    ];
    expect(customerStepFromTimedSignals(
      ["exception"],
      providerReceived,
      resolveProviderExceptionRecovery({
        fulfillmentOrderId,
        releasedHolds: [hold({ metadata: recoveryMetadata({
          autoReleaseEvidence: { providerStatus: "NEW", localStatus: "provider_received" },
        }) })],
        statusEvidence: providerReceived,
      }),
    )).toBe("accepted");

    const shippingFailed = [
      evidence({ providerStatus: "SHIPPING_FAILED" }),
      evidence({ id: "recovery-evidence", providerStatus: "AWAITING_COURIER", localStatus: "packed", token: "packed", occurredAt: recoveryAt }),
    ];
    expect(resolveProviderExceptionRecovery({
      fulfillmentOrderId,
      releasedHolds: [hold({
        metadata: recoveryMetadata({
          autoReleaseEvidence: { providerStatus: "AWAITING_COURIER", clearedProviderStatus: "SHIPPING_FAILED" },
        }),
      })],
      statusEvidence: shippingFailed,
    }).clearedExceptionEvidenceIds).toEqual(new Set());
  });

  it("fails closed for a later exception, manual hold, malformed metadata, or equal timestamps", () => {
    const statusEvidence = [
      evidence(),
      evidence({ id: "recovery-evidence", providerStatus: "AWAITING_COURIER", localStatus: "packed", token: "packed", occurredAt: recoveryAt }),
      evidence({ id: "later-exception", providerStatus: "RETURNED_TO_SENDER", localStatus: "exception", token: "exception", occurredAt: "2026-08-04T10:02:00.000Z" }),
    ];
    const valid = resolveProviderExceptionRecovery({ fulfillmentOrderId, releasedHolds: [hold()], statusEvidence });
    expect(customerStepFromTimedSignals(["exception"], statusEvidence, valid)).toBe("exception");

    for (const invalidHold of [
      hold({ createdBy: "operator-1" }),
      hold({ metadata: {} }),
      hold({ metadata: recoveryMetadata({ autoReleaseEvidence: { occurredAt: exceptionAt } }) }),
    ]) {
      expect(resolveProviderExceptionRecovery({ fulfillmentOrderId, releasedHolds: [invalidHold], statusEvidence }).clearedExceptionEvidenceIds).toEqual(new Set());
    }
  });
});

describe("terminal order cap", () => {
  it("caps only the order statuses the canon calls cancelled", () => {
    for (const terminal of ["cancelled", "refunded", "CANCELLED", "Refunded", "canceled"]) {
      expect(customerStepForTerminalOrder(terminal)).toBe("cancelled");
    }
    for (const live of [
      "paid",
      "fulfillment_pending",
      "pending_payment",
      "fulfilled",
      "expired",
      "payment_failed",
      "",
      null,
      undefined,
    ]) {
      expect(customerStepForTerminalOrder(live)).toBeNull();
    }
  });
});
