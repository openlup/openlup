import { describe, expect, it, vi } from "vitest";

import {
  createSubscriberRetentionMessaging,
  type SubscriberDeliveryAction,
} from "./subscriberRetentionMessaging.js";
import type {
  SubscriberMessageIntent,
  SubscriberRetentionPort,
  SubscriptionAutoResumePort,
} from "./subscriberRetention.js";

const INPUT = {
  idempotencyKey: "retention-intent-1",
  subjectReference: "subject-1",
  subscriptionId: "11111111-1111-4111-8111-111111111111",
  sourceReference: "subscription:11111111-1111-4111-8111-111111111111",
  kind: "winback" as const,
  templateReference: "subscriber-winback-v1",
  expectedRevision: 1,
  recipientFingerprint: "a".repeat(64),
  controlKey: "subscriber-retention",
  consentPurpose: "retention_marketing",
};

function planned(overrides: Partial<SubscriberMessageIntent> = {}): SubscriberMessageIntent {
  return {
    intentId: "22222222-2222-4222-8222-222222222222",
    subjectReference: INPUT.subjectReference,
    subscriptionId: INPUT.subscriptionId,
    sourceReference: INPUT.sourceReference,
    accessGrantReference: null,
    kind: INPUT.kind,
    templateReference: INPUT.templateReference,
    fingerprint: "b".repeat(64),
    status: "planned",
    refusal: null,
    deliveryReference: null,
    attemptCount: 0,
    replayed: false,
    ...overrides,
  };
}

function fixture(first: SubscriberMessageIntent = planned()) {
  const retention = {
    run: vi.fn(async () => ({ ok: true, scanned: 0, resumed: 0, skippedRows: 0, failed: 0 })),
    upsertProfile: vi.fn(),
    createIntent: vi.fn(async () => first),
    claimIntent: vi.fn<SubscriberRetentionPort["claimIntent"]>(async (idempotencyKey, fingerprint) => ({
      idempotencyKey, fingerprint, subjectReference: first.subjectReference, kind: first.kind,
      templateReference: first.templateReference, accessGrantReference: first.accessGrantReference,
      claimReference: "retention-claim:11111111-1111-4111-8111-111111111111",
    })),
    planDue: vi.fn(async () => ({ scanned: 0, planned: 0, refused: 0, replayed: 0 })),
    listPending: vi.fn<SubscriberRetentionPort["listPending"]>(async () => []),
    recordDelivery: vi.fn(async (input) => planned({
      status: input.state,
      refusal: input.state === "failed" ? "delivery_failed" : null,
      deliveryReference: input.deliveryReference,
      attemptCount: input.attemptCount,
    })),
    readProfile: vi.fn(),
    readIntent: vi.fn(),
  } satisfies SubscriberRetentionPort & SubscriptionAutoResumePort;
  const delivery = {
    send: vi.fn(async () => ({
      idempotencyKey: INPUT.idempotencyKey,
      commandFingerprint: "c".repeat(64),
      state: "accepted" as const,
      deliveryReference: "captured:retention-1",
      errorCode: null,
      attemptCount: 1,
    })),
    readReceipt: vi.fn<SubscriberDeliveryAction["readReceipt"]>(async () => null),
  };
  return { retention, delivery, messaging: createSubscriberRetentionMessaging({ retention, delivery }) };
}

describe("subscriber retention messaging owner", () => {
  it("authorizes first, then uses the shipped delivery action and reconciles its receipt", async () => {
    const { retention, delivery, messaging } = fixture();
    await expect(messaging.deliverIntent(INPUT)).resolves.toMatchObject({
      status: "accepted",
      deliveryReference: "captured:retention-1",
    });
    expect(retention.createIntent).toHaveBeenCalledWith(expect.objectContaining({
      ...INPUT,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(delivery.send).toHaveBeenCalledWith({
      idempotencyKey: INPUT.idempotencyKey,
      recipientReference: INPUT.subjectReference,
      templateReference: INPUT.templateReference,
    });
    expect(retention.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      state: "accepted",
      deliveryReference: "captured:retention-1",
      attemptCount: 1,
    }));
  });

  it("never invokes delivery for a durable policy refusal", async () => {
    const { delivery, messaging } = fixture(planned({
      status: "refused",
      refusal: "consent_missing",
    }));
    await expect(messaging.deliverIntent(INPUT)).resolves.toMatchObject({
      status: "refused",
      refusal: "consent_missing",
    });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it("reconciles a captured failed receipt after the delivery action throws", async () => {
    const { retention, delivery, messaging } = fixture();
    delivery.send.mockRejectedValueOnce(new Error("transactional_delivery_unavailable"));
    delivery.readReceipt.mockResolvedValueOnce({
      state: "failed",
      deliveryReference: null,
      attemptCount: 1,
    });
    await expect(messaging.deliverIntent(INPUT)).resolves.toMatchObject({
      status: "failed",
      refusal: "delivery_failed",
    });
    expect(retention.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      state: "failed",
      attemptCount: 1,
    }));
  });

  it("retries a durable failed intent through the same delivery action", async () => {
    const { delivery, messaging } = fixture(planned({
      status: "failed",
      refusal: "delivery_failed",
      attemptCount: 1,
      replayed: true,
    }));
    delivery.send.mockResolvedValueOnce({
      idempotencyKey: INPUT.idempotencyKey,
      commandFingerprint: "c".repeat(64),
      state: "accepted",
      deliveryReference: "captured:retention-retry",
      errorCode: null,
      attemptCount: 2,
    });
    await expect(messaging.deliverIntent(INPUT)).resolves.toMatchObject({
      status: "accepted",
      attemptCount: 2,
    });
    expect(delivery.send).toHaveBeenCalledOnce();
  });

  it("dispatches durable pending intents through the same delivery owner", async () => {
    const { retention, delivery, messaging } = fixture();
    retention.listPending.mockResolvedValueOnce([{
      idempotencyKey: INPUT.idempotencyKey,
      subjectReference: INPUT.subjectReference,
      kind: "winback",
      templateReference: INPUT.templateReference,
      accessGrantReference: null,
      fingerprint: "b".repeat(64),
      claimReference: "retention-claim:11111111-1111-4111-8111-111111111111",
    }]);

    await expect(messaging.dispatchPending("winback", 25)).resolves.toEqual({
      ok: true, scanned: 1, accepted: 1, failed: 0,
    });
    expect(retention.listPending).toHaveBeenCalledWith("winback", 25);
    expect(delivery.send).toHaveBeenCalledWith({
      idempotencyKey: INPUT.idempotencyKey,
      recipientReference: INPUT.subjectReference,
      templateReference: INPUT.templateReference,
    });
  });

  it("reconciles a failed receipt while dispatching pending production work", async () => {
    const { retention, delivery, messaging } = fixture();
    retention.listPending.mockResolvedValueOnce([{
      idempotencyKey: INPUT.idempotencyKey, subjectReference: INPUT.subjectReference,
      kind: "review_request", templateReference: INPUT.templateReference,
      accessGrantReference: "review-grant:11111111-1111-4111-8111-111111111111",
      fingerprint: "b".repeat(64), claimReference: "retention-claim:11111111-1111-4111-8111-111111111111",
    }]);
    delivery.send.mockRejectedValueOnce(new Error("captured_delivery_failed"));
    delivery.readReceipt.mockResolvedValueOnce({ state: "failed", deliveryReference: null, attemptCount: 1 });
    await expect(messaging.dispatchPending("review_request", 25)).resolves.toEqual({
      ok: true, scanned: 1, accepted: 0, failed: 1,
    });
    expect(retention.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      state: "failed", attemptCount: 1,
    }));
  });

  it("plans canonical production work before dispatching it", async () => {
    const { retention, messaging } = fixture();
    retention.planDue.mockResolvedValueOnce({ scanned: 2, planned: 1, refused: 1, replayed: 0 });
    await expect(messaging.planAndDispatch("review_request", 25)).resolves.toEqual({
      ok: true, scanned: 2, planned: 1, refused: 1, replayed: 0, accepted: 0, failed: 0,
    });
    expect(retention.planDue).toHaveBeenCalledWith("review_request", 25);
    expect(retention.planDue).toHaveBeenCalledWith("review_effects", 25);
    expect(retention.listPending).toHaveBeenCalledWith("review_request", 25);
    expect(retention.listPending).toHaveBeenCalledWith("review_effects", 25);
  });
});
