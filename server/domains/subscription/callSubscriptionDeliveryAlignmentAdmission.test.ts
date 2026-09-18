import { describe, expect, it, vi } from "vitest";
import {
  callSubscriptionDeliveryAlignmentAdmission,
  checkSubscriptionDeliveryAlignmentAdmission,
  deliveryAlignmentBlockResult,
  parseDeliveryAlignmentAdmissionResponse,
} from "./callSubscriptionDeliveryAlignmentAdmission.js";
import type { DueSubscription } from "./chargeSubscriptionCycleOffSession.js";

const due = { subscriptionId: "sub-1", nextCycleAt: "2026-08-10T00:00:00Z" } as DueSubscription;
const asOf = "2026-08-10T00:01:00Z";
const allowed = { allowed: true, state: "none", reason: "no_delay_evidence" };

describe("delivery alignment admission", () => {
  it("delegates the exact admission boundary input", async () => {
    const admitDeliveryAlignment = vi.fn().mockResolvedValue(allowed);

    await expect(callSubscriptionDeliveryAlignmentAdmission({ admitDeliveryAlignment }, {
      subscriptionId: due.subscriptionId,
      scheduledAt: due.nextCycleAt,
      asOf,
    })).resolves.toMatchObject({ allowed: true });
    expect(admitDeliveryAlignment).toHaveBeenCalledWith({
      subscriptionId: due.subscriptionId,
      scheduledAt: due.nextCycleAt,
      asOf,
    });
  });

  it("returns admitted details for an allowed renewal", async () => {
    const client = { admitDeliveryAlignment: vi.fn().mockResolvedValue(allowed) };

    await expect(checkSubscriptionDeliveryAlignmentAdmission(client, due, asOf))
      .resolves.toEqual({
        admitted: { allowed: true, state: "none", reason: "no_delay_evidence" },
        blocked: null,
      });
    await expect(deliveryAlignmentBlockResult(client, due, asOf))
      .resolves.toBeNull();
  });

  it("stops a protected renewal before artifacts are created", async () => {
    const client = {
      admitDeliveryAlignment: vi.fn().mockResolvedValue({
        allowed: false,
        state: "protected",
        reason: "delivery_alignment_protected",
      }),
    };
    await expect(deliveryAlignmentBlockResult(client, due, asOf))
      .resolves.toEqual({
        subscriptionId: "sub-1",
        outcome: "skipped",
        cycleId: null,
        cycleNumber: null,
        orderId: null,
        paymentIntentId: null,
        attemptStatus: null,
        replayed: false,
        reason: "delivery_alignment_protected",
      });
  });

  it("rejects RPC failures and malformed responses", () => {
    expect(() => parseDeliveryAlignmentAdmissionResponse(null, { message: "db unavailable" }))
      .toThrow("subscription_delivery_alignment_admission_failed: db unavailable");
    expect(() => parseDeliveryAlignmentAdmissionResponse({ allowed: true }, null))
      .toThrow("subscription_delivery_alignment_admission_invalid_response");
  });
});
