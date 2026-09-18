import { describe, expect, it } from "vitest";
import {
  customer360RecoverySchema,
  customer360SnapshotResponseSchema,
} from "./customer360Contracts.js";
import {
  customerRecoveryCommandRequestSchema,
  customerRecoveryCommandResponseSchema,
} from "./customerSupportCommandContracts.js";
describe("portable customer-360 contracts", () => {
  it("keeps token state separate from action eligibility", () => {
    const recovery = { caseId: "case-1", status: "unavailable", actionAvailable: true, lastIssuedAt: null, lastDeliveryStatus: null };
    expect(customer360RecoverySchema.parse(recovery)).toMatchObject({ status: "unavailable", actionAvailable: true });
    expect(customer360RecoverySchema.safeParse({ ...recovery, status: "open" }).success).toBe(false);
  });
  it("accepts a provider-neutral lifecycle and recovery projection", () => {
    const result = customer360SnapshotResponseSchema.safeParse({
      contractVersion: "support.customer_360.v2",
      lookup: {
        query: "buyer@example.com",
        matchedBy: "email",
        confidence: "exact",
        warnings: [],
      },
      subject: {
        subjectId: "subject-1",
        displayName: "A Buyer",
        email: "buyer@example.com",
        lifecycleStage: "customer",
        lifecycle: [
          { stage: "lead", enteredAt: "2026-08-01T10:00:00.000Z", exitedAt: "2026-08-02T10:00:00.000Z" },
          { stage: "waitlist", enteredAt: "2026-08-02T10:00:00.000Z", exitedAt: "2026-08-03T10:00:00.000Z" },
          { stage: "tester", enteredAt: "2026-08-03T10:00:00.000Z", exitedAt: "2026-08-04T10:00:00.000Z" },
          { stage: "customer", enteredAt: "2026-08-04T10:00:00.000Z", exitedAt: null },
        ],
        firstSeenAt: "2026-08-01T10:00:00.000Z",
        lastActivityAt: "2026-08-15T10:00:00.000Z",
      },
      orders: [{
        orderId: "order-1",
        orderNumber: "OPENLUP-1",
        status: "payment_failed",
        subscriptionId: "subscription-1",
        totalMinor: 4900,
        currency: "XTS",
        createdAt: "2026-08-15T09:00:00.000Z",
      }],
      subscriptions: [{
        subscriptionId: "subscription-1",
        status: "past_due",
        nextCycleAt: null,
        latestOrderId: "order-1",
      }],
      payment: [{
        orderId: "order-1",
        status: "failed",
        recoverable: true,
        amountMinor: 4900,
        currency: "XTS",
        lastAttemptAt: "2026-08-15T09:05:00.000Z",
      }],
      dunningCases: [{
        caseId: "case-1",
        subscriptionId: "subscription-1",
        orderId: "order-1",
        status: "open",
        retryAttempt: 1,
        nextRetryAt: "2026-08-16T09:05:00.000Z",
        notificationStatus: "queued",
        recoveryAvailable: true,
      }],
      recovery: [{
        caseId: "case-1",
        status: "available",
        actionAvailable: true,
        lastIssuedAt: null,
        lastDeliveryStatus: null,
      }],
      auditTrail: [{
        eventId: "audit-1",
        occurredAt: "2026-08-15T09:05:00.000Z",
        action: "dunning_case_opened",
        outcome: "accepted",
        entity: { kind: "dunning_case", id: "case-1" },
      }],
    });
    expect(result.success).toBe(true);
  });
  it("treats contact health and the sign-in link as optional evidence", () => {
    const base = {
      contractVersion: "support.customer_360.v2",
      lookup: { query: "subject-1", matchedBy: "subject_id", confidence: "exact", warnings: [] },
      subject: {
        subjectId: "subject-1", displayName: null, email: null, lifecycleStage: "customer",
        lifecycle: [], firstSeenAt: null, lastActivityAt: null,
      },
      orders: [], subscriptions: [], payment: [], dunningCases: [], recovery: [], auditTrail: [],
    };
    // A deployment with no delivery evidence omits the key entirely.
    expect(customer360SnapshotResponseSchema.safeParse(base).success).toBe(true);
    expect(customer360SnapshotResponseSchema.safeParse({
      ...base,
      subject: { ...base.subject, authUserLinked: false },
      contactHealth: { lastTerminalStatus: "bounced", lastTerminalAt: "2026-08-14T10:00:00.000Z", reachable: false },
    }).success).toBe(true);
    // Statuses that mean "no mail was owed" are not deliverability outcomes.
    for (const lastTerminalStatus of ["skipped", "blocked", "queued", "sent"]) {
      expect(customer360SnapshotResponseSchema.safeParse({
        ...base, contactHealth: { lastTerminalStatus, lastTerminalAt: null, reachable: true },
      }).success).toBe(false);
    }
    // No attempt counter may sneak in beside the flag.
    expect(customer360SnapshotResponseSchema.safeParse({
      ...base,
      contactHealth: { lastTerminalStatus: null, lastTerminalAt: null, reachable: true, consecutiveFailures: 3 },
    }).success).toBe(false);
  });
  it("carries only shippable saved addresses, and says nothing rather than none", () => {
    const base = {
      contractVersion: "support.customer_360.v2",
      lookup: { query: "subject-1", matchedBy: "subject_id", confidence: "exact", warnings: [] },
      subject: {
        subjectId: "subject-1", displayName: null, email: null, lifecycleStage: "customer",
        lifecycle: [], firstSeenAt: null, lastActivityAt: null,
      },
      orders: [], subscriptions: [], payment: [], dunningCases: [], recovery: [], auditTrail: [],
    };
    const home = {
      addressId: "address-1", label: "Home", recipientName: "A Buyer", line1: "Flower 1", line2: null,
      postalCode: "00-002", city: "Southtown", country: "XX", contactPhone: null, isDefault: true, kind: "shipping",
    };
    // A lane that cannot read them omits the key; one that read and found none says so.
    expect(customer360SnapshotResponseSchema.safeParse(base).success).toBe(true);
    expect(customer360SnapshotResponseSchema.safeParse({ ...base, addresses: [] }).success).toBe(true);
    expect(customer360SnapshotResponseSchema.safeParse({ ...base, addresses: [home] }).success).toBe(true);
    // A billing-only row is not a delivery destination and cannot reach the picker.
    expect(customer360SnapshotResponseSchema.safeParse({
      ...base, addresses: [{ ...home, kind: "billing" }],
    }).success).toBe(false);
    // A street a parcel cannot be delivered to, and an unbounded list, are both refused.
    expect(customer360SnapshotResponseSchema.safeParse({ ...base, addresses: [{ ...home, line1: "" }] }).success).toBe(false);
    expect(customer360SnapshotResponseSchema.safeParse({
      ...base, addresses: Array.from({ length: 21 }, (_value, index) => ({ ...home, addressId: `address-${index}` })),
    }).success).toBe(false);
    // The subscription pointer follows the same rule: absent, or an id, or an explicit null.
    const subscription = { subscriptionId: "subscription-1", status: "active", nextCycleAt: null, latestOrderId: null };
    for (const entry of [subscription, { ...subscription, shippingAddressId: null }, { ...subscription, shippingAddressId: "address-1" }]) {
      expect(customer360SnapshotResponseSchema.safeParse({ ...base, subscriptions: [entry] }).success).toBe(true);
    }
  });
  it("rejects provider evidence and token material from the public snapshot", () => {
    const result = customer360SnapshotResponseSchema.safeParse({
      contractVersion: "support.customer_360.v2",
      lookup: { query: "subject-1", matchedBy: "subject_id", confidence: "exact", warnings: [] },
      subject: {
        subjectId: "subject-1",
        displayName: null,
        email: null,
        lifecycleStage: "lead",
        lifecycle: [],
        firstSeenAt: null,
        lastActivityAt: null,
      },
      orders: [],
      subscriptions: [],
      payment: [],
      dunningCases: [],
      recovery: [],
      auditTrail: [],
      providerRefs: [{ provider: "private" }],
      recoveryToken: "secret",
    });
    expect(result.success).toBe(false);
  });
  it("accepts the recovery command but rejects secret-bearing responses", () => {
    expect(customerRecoveryCommandRequestSchema.safeParse({
      action: "issue_recovery",
      subjectId: "subject-1",
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
    }).success).toBe(true);
    expect(customerRecoveryCommandResponseSchema.safeParse({
      contractVersion: "support.customer_360.v2",
      action: "issue_recovery",
      subjectId: "subject-1",
      caseId: "case-1",
      outcome: "issued",
      replayed: false,
      deliveryStatus: "queued",
      auditEventId: "audit-1",
      tokenHash: "must-not-escape",
    }).success).toBe(false);
  });
});
