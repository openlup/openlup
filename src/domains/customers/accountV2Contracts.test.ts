import { describe, expect, it } from "vitest";
import {
  CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
  customerAccountV2ResponseSchema,
  customerAccountV2SubscriptionSchema,
  customerBillingProfileUpsertRequestSchema,
  customerInvoiceDownloadRequestSchema,
  customerOrderDetailResponseSchema,
} from "./accountV2Contracts.js";
import {
  customerPaymentRecoveryStartResponseSchema,
  customerSubscriptionPreviewResponseSchema,
} from "./subscriptionFacadeContracts.js";
import { SUBSCRIPTION_RECORD_STATUSES } from "../subscription/types.js";

const now = "2026-06-08T10:00:00+00:00";
const id = "11111111-1111-4111-8111-111111111111";

describe("customer account v2 contracts", () => {
  it("accepts the hidden account aggregate with order and invoice summaries", () => {
    const parsed = customerAccountV2ResponseSchema.parse({
      contractVersion: CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
      profile: {
        clientId: id,
        email: "buyer@example.com",
        firstName: "Ada",
        lastName: null,
        phone: null,
        lifecycleStage: "customer",
      },
      pets: [],
      subscriptions: [
        {
          subscriptionId: id,
          petId: null,
          shippingAddressId: id,
          status: "active",
          pausePreset: null,
          pauseStartedAt: null,
          pauseEndsAt: null,
          cadenceDays: 28,
          nextCycleAt: now,
          editCutoffAt: now,
          canEditUpcomingPackage: true,
          editBlockedReason: null,
          paymentMethodKind: "card",
          paymentMethodStatus: "usable",
          templateVersion: 1,
          sizeConstraint: null,
          packageSummary: "1 recipe",
          recurringPrice: {
            subtotalGross: { amountMinor: 18760, currency: "PLN" },
            totalGross: { amountMinor: 18760, currency: "PLN" },
            currency: "PLN",
            source: "frozen_quote_line",
          },
          lines: [
            {
              lineId: id,
              variantId: id,
              qty: 1,
              sortOrder: 0,
              isAddon: false,
              title: "Beef",
              sku: "dog-beef",
              recipeName: "beef",
              unitPrice: { amountMinor: 18760, currency: "PLN" },
              lineSubtotal: { amountMinor: 18760, currency: "PLN" },
            },
          ],
        },
      ],
      addresses: [],
      ordererProfiles: [],
      billingProfiles: [],
      paymentPreferences: [],
      actionRequired: [
        {
          actionId: "subscription:11111111-1111-4111-8111-111111111111:payment_blocked",
          kind: "payment_recovery",
          severity: "critical",
          entityType: "subscription",
          entityId: id,
          subscriptionId: id,
          orderId: null,
          messageCode: "payment_blocked",
          failureCause: "unknown" as const,
          blockedReason: "payment_blocked",
          title: "Payment blocked",
          body: "Repair the payment method.",
          cta: "repair_payment",
          recoveryEligible: true,
          dueAt: null,
          nextRetryAt: now,
        },
      ],
      recentOrders: [orderSummary()],
      events: [],
    });

    expect(parsed.recentOrders[0]?.invoice?.invoiceRef).toBe("FV-1");
    expect(parsed.recentOrders[0]?.invoice?.downloadUrl).toContain("/api/bff/customers/invoices/download");
    expect(parsed.recentOrders[0]?.invoice?.documentDeliveryStatus).toBe("pdf_ready");
    expect(parsed.recentOrders[0]?.invoiceDocuments[0]).toMatchObject({
      role: "original",
      artifact: "invoice",
      isCurrent: true,
    });
    expect(parsed.actionRequired[0]?.messageCode).toBe("payment_blocked");
  });

  it("accepts every persisted subscription status, including activation states", () => {
    // Regression: a subscription in pending_activation / activation_failed must
    // parse, otherwise the whole account payload fails validation and the
    // dashboard shows "Dane konta są chwilowo niedostępne" (see DB CHECK on
    // subscriptions.status).
    expect(SUBSCRIPTION_RECORD_STATUSES).toContain("pending_activation");
    expect(SUBSCRIPTION_RECORD_STATUSES).toContain("activation_failed");

    const baseSubscription = {
      subscriptionId: id,
      petId: null,
      shippingAddressId: null,
      pausePreset: null,
      pauseStartedAt: null,
      pauseEndsAt: null,
      cadenceDays: 28,
      nextCycleAt: null,
      editCutoffAt: null,
      canEditUpcomingPackage: false,
      editBlockedReason: "not_active" as const,
      paymentMethodKind: null,
      templateVersion: 1,
      sizeConstraint: null,
      packageSummary: null,
      recurringPrice: null,
      lines: [],
    };

    for (const status of SUBSCRIPTION_RECORD_STATUSES) {
      expect(() =>
        customerAccountV2SubscriptionSchema.parse({ ...baseSubscription, status }),
      ).not.toThrow();
    }
  });

  it("keeps delivery-alignment facts additive and customer-safe", () => {
    const baseSubscription = {
      subscriptionId: id,
      petId: null,
      shippingAddressId: null,
      status: "active" as const,
      pausePreset: null,
      pauseStartedAt: null,
      pauseEndsAt: null,
      cadenceDays: 28,
      nextCycleAt: now,
      editCutoffAt: now,
      canEditUpcomingPackage: true,
      editBlockedReason: null,
      paymentMethodKind: "card",
      templateVersion: 1,
      sizeConstraint: null,
      packageSummary: null,
      recurringPrice: null,
      lines: [],
    };

    expect(customerAccountV2SubscriptionSchema.parse(baseSubscription).deliveryAlignment).toBeUndefined();
    for (const state of ["protected", "aligned"] as const) {
      expect(
        customerAccountV2SubscriptionSchema.parse({
          ...baseSubscription,
          deliveryAlignment: { state },
        }).deliveryAlignment,
      ).toEqual({ state });
    }
    expect(() =>
      customerAccountV2SubscriptionSchema.parse({
        ...baseSubscription,
        deliveryAlignment: { state: "aligned", operatorReason: "provider_attempt_exists" },
      }),
    ).toThrow();
  });

  it("accepts customer-safe order detail without provider refs", () => {
    const parsed = customerOrderDetailResponseSchema.parse({
      contractVersion: "customer.orders.v2",
      order: {
        ...orderSummary(),
        subtotal: { amountMinor: 1000, currency: "PLN" },
        discount: { amountMinor: 0, currency: "PLN" },
        shipping: { amountMinor: 0, currency: "PLN" },
        tax: { amountMinor: 80, currency: "PLN" },
        lines: [
          {
            lineId: id,
            skuId: id,
            title: "Beef",
            quantity: 1,
            unitPrice: { amountMinor: 1000, currency: "PLN" },
            total: { amountMinor: 1000, currency: "PLN" },
            recipeName: "beef",
            variantName: "small",
          },
        ],
        fulfillment: {
          fulfillmentOrderId: id,
          status: "label_created",
          providerKind: "inpost_mock",
          trackingNumber: "TRACK-1",
          trackingNumbers: ["TRACK-1", "TRACK-2"],
          trackingReferences: [trackingReference()],
          lastEventType: "label_created",
          updatedAt: now,
          trackingTimeline: [trackingEvent("label_created", "Przygotowane do wysylki", "fulfillment")],
        },
      },
    });

    expect(parsed.order.fulfillment?.trackingNumber).toBe("TRACK-1");
    expect(parsed.order.trackingNumbers).toEqual(["TRACK-1", "TRACK-2"]);
    expect(parsed.order.trackingTimeline[0]?.label).toBe("W drodze");
  });

  it("requires idempotency for billing profile writes", () => {
    expect(() =>
      customerBillingProfileUpsertRequestSchema.parse({
        idempotencyKey: "short",
        fullName: "Ada Buyer",
        email: "buyer@example.com",
      }),
    ).toThrow();
  });

  it("keeps legacy invoice downloads compatible and validates correction artifacts", () => {
    expect(customerInvoiceDownloadRequestSchema.parse({ invoiceId: id })).toEqual({
      invoiceId: id,
      artifact: "invoice",
    });
    expect(customerInvoiceDownloadRequestSchema.parse({ invoiceId: id, artifact: "correction" })).toEqual({
      invoiceId: id,
      artifact: "correction",
    });
  });

  it("accepts invalid_address as a subscription preview blocked reason", () => {
    expect(
      customerSubscriptionPreviewResponseSchema.parse({
        preview: {
          subscriptionId: id,
          action: "change_shipping_address",
          canApply: false,
          blockedReason: "invalid_address",
          nextCycleAt: now,
          editCutoffAt: now,
          templateVersion: 1,
        },
      }).preview.blockedReason,
    ).toBe("invalid_address");
  });

  it("accepts customer subscription preview and recovery-start facade responses", () => {
    expect(
      customerSubscriptionPreviewResponseSchema.parse({
        preview: {
          subscriptionId: id,
          action: "swap_recipe",
          canApply: false,
          blockedReason: "missing_payment_method",
          nextCycleAt: now,
          editCutoffAt: now,
          templateVersion: 1,
        },
      }).preview.blockedReason,
    ).toBe("missing_payment_method");

    expect(customerPaymentRecoveryStartResponseSchema.parse({
      recoverable: true,
      recoveryUrlPath: "/konto/platnosc/napraw?token=rcv_abc",
      caseId: id,
      expiresAt: now,
      nextRetryAt: null,
    })).toMatchObject({
      recoverable: true,
      caseId: id,
    });
    expect(customerPaymentRecoveryStartResponseSchema.parse({
      recoverable: false,
      reason: "no_open_dunning_case",
    })).toEqual({
      recoverable: false,
      reason: "no_open_dunning_case",
    });
  });

  it("normalizes and rejects billing profile NIP before persistence", () => {
    expect(
      customerBillingProfileUpsertRequestSchema.parse({
        idempotencyKey: "billing-profile-1",
        fullName: "Ada Buyer",
        email: "buyer@example.com",
        taxId: "123-456-32-18",
      }).taxId,
    ).toBe("1234563218");

    expect(
      customerBillingProfileUpsertRequestSchema.parse({
        idempotencyKey: "billing-profile-2",
        fullName: "Ada Buyer",
        email: "buyer@example.com",
        taxId: "",
      }).taxId,
    ).toBeNull();

    expect(() =>
      customerBillingProfileUpsertRequestSchema.parse({
        idempotencyKey: "billing-profile-3",
        fullName: "Ada Buyer",
        email: "buyer@example.com",
        taxId: "123",
      }),
    ).toThrow("forms:fields.taxId.invalid");
  });

  it("accepts billing profile company identity verification metadata", () => {
    expect(
      customerBillingProfileUpsertRequestSchema.parse({
        idempotencyKey: "billing-profile-verified-1",
        fullName: "Ada Buyer",
        email: "buyer@example.com",
        taxId: "123-456-32-18",
        companyName: "Example Company Sp. z o.o.",
        companyVerificationLevel: "registry_verified",
        companyIdentitySource: "gus_ceidg",
        companyIdentityEvidenceHash: "sha256:test",
      }),
    ).toMatchObject({
      taxId: "1234563218",
      companyVerificationLevel: "registry_verified",
      companyIdentitySource: "gus_ceidg",
      companyIdentityEvidenceHash: "sha256:test",
    });
  });
});

function orderSummary() {
  return {
    orderId: id,
    orderRef: `order_${id}`,
    orderNumber: "1001",
    subscriptionId: null,
    status: "paid",
    paymentStatus: "succeeded",
    fulfillmentStatus: "label_created",
    total: { amountMinor: 1000, currency: "PLN" },
    trackingNumber: "TRACK-1",
    trackingNumbers: ["TRACK-1", "TRACK-2"],
    trackingUrl: null,
    carrierKind: "omnipack",
    service: null,
    trackingReferences: [trackingReference()],
    trackingTimeline: [trackingEvent("shipped", "W drodze", "reconciliation")],
    invoice: {
      invoiceId: id,
      orderId: id,
      invoiceRef: "FV-1",
      status: "issued",
      providerInvoiceNumber: "FV-1",
      ksefNumber: null,
      ksefStatus: "not_submitted",
      documentDeliveryStatus: "pdf_ready",
      totalGross: { amountMinor: 1000, currency: "PLN" },
      issuedAt: now,
      downloadAvailable: true,
      downloadUrl: `/api/bff/customers/invoices/download?invoiceId=${id}`,
      createdAt: now,
    },
    invoiceDocuments: [{
      documentKey: `invoice:${id}`,
      invoiceId: id,
      orderId: id,
      invoiceRef: "FV-1",
      role: "original",
      artifact: "invoice",
      isCurrent: true,
      status: "issued",
      providerInvoiceNumber: "FV-1",
      ksefNumber: null,
      ksefStatus: "not_submitted",
      documentDeliveryStatus: "pdf_ready",
      totalGross: { amountMinor: 1000, currency: "PLN" },
      issuedAt: now,
      downloadAvailable: true,
      downloadUrl: `/api/bff/customers/invoices/download?invoiceId=${id}`,
      createdAt: now,
    }],
    invoiceRequestStatus: "available",
    createdAt: now,
    updatedAt: now,
  };
}

function trackingReference() {
  return {
    providerKind: "omnipack",
    trackingNumber: "TRACK-1",
    trackingUrl: null,
    carrierKind: "omnipack",
    service: null,
    updatedAt: now,
  };
}

function trackingEvent(eventType: string, label: string, source: "reconciliation" | "fulfillment") {
  return { eventType, label, occurredAt: now, source };
}
