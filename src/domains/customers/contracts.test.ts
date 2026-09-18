import { describe, expect, it } from "vitest";
import {
  CUSTOMER_ADDRESSES_CONTRACT_VERSION,
  CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION,
  CUSTOMER_PREFERENCES_CONTRACT_VERSION,
  customerAddressesResponseSchema,
  customerPaymentMethodsResponseSchema,
  customerPaymentPreferenceUpsertRequestSchema,
  customerPaymentPreferencesResponseSchema,
  customerMagicLinkRequestSchema,
  normalizeCustomerReturnTo,
} from "./contracts.js";

describe("customer auth return target contracts", () => {
  it("preserves safe account paths with query and hash", () => {
    expect(normalizeCustomerReturnTo("/konto/zamowienie/status?orderId=abc#payment")).toBe(
      "/konto/zamowienie/status?orderId=abc#payment",
    );
    expect(
      customerMagicLinkRequestSchema.parse({
        email: " Buyer@Example.com ",
        returnTo: "/account/order/status?orderId=abc#payment",
      }),
    ).toEqual({
      email: "buyer@example.com",
      locale: "pl",
      returnTo: "/account/order/status?orderId=abc#payment",
    });
  });

  it("strips bearer credentials from payment-recovery return targets", () => {
    expect(normalizeCustomerReturnTo(
      "/konto/platnosc/napraw?token=bearer&source=tpay&setup_intent_client_secret=secret&redirect_status=succeeded#payment",
    )).toBe("/konto/platnosc/napraw?source=tpay#payment");
    expect(customerMagicLinkRequestSchema.parse({
      email: "buyer@example.com",
      returnTo: "/account/payment/recover?token=bearer&payment_intent_client_secret=secret",
    }).returnTo).toBe("/account/payment/recover");
  });

  it.each([
    "https://evil.test/konto",
    "//evil.test/account",
    "/admin",
    "/accountant",
    "/konto-evil",
    "/konto/../admin",
    "/konto\\@evil.test",
  ])("rejects unsafe return target %s", (returnTo) => {
    expect(normalizeCustomerReturnTo(returnTo)).toBeNull();
    expect(
      customerMagicLinkRequestSchema.safeParse({ email: "buyer@example.com", returnTo }).success,
    ).toBe(false);
  });
});

describe("customer preference contracts", () => {
  it("accepts sanitized payment preference summaries only", () => {
    const parsed = customerPaymentPreferencesResponseSchema.parse({
      contractVersion: CUSTOMER_PREFERENCES_CONTRACT_VERSION,
      preferences: [
        {
          scope: "subscription",
          methodKind: "card",
          lastSelectedAt: "2026-06-06T12:00:00.000+02:00",
        },
      ],
    });

    expect(parsed.preferences[0]).toEqual({
      scope: "subscription",
      methodKind: "card",
      lastSelectedAt: "2026-06-06T12:00:00.000+02:00",
    });
  });

  it("rejects provider payment method refs and unsupported methods", () => {
    expect(() =>
      customerPaymentPreferencesResponseSchema.parse({
        contractVersion: CUSTOMER_PREFERENCES_CONTRACT_VERSION,
        preferences: [
          {
            scope: "one_time",
            methodKind: "pm_123",
            paymentMethodRef: "pm_secret",
            lastSelectedAt: "2026-06-06T12:00:00.000+02:00",
          },
        ],
      }),
    ).toThrow();
  });

  it("validates hidden preference upserts", () => {
    expect(
      customerPaymentPreferenceUpsertRequestSchema.parse({
        scope: "any",
        methodKind: "blik",
      }),
    ).toEqual({ scope: "any", methodKind: "blik" });

    expect(() =>
      customerPaymentPreferenceUpsertRequestSchema.parse({
        scope: "any",
        methodKind: "blik",
        selectedAt: "2026-06-06T12:00:00.000+02:00",
      }),
    ).toThrow();
  });

  it("accepts public saved BLIK PAYID method summaries without raw PAYID", () => {
    const parsed = customerPaymentMethodsResponseSchema.parse({
      contractVersion: CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION,
      paymentMethods: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "tpay",
          methodKind: "blik_payid",
          status: "active",
          usableFor: ["one_time", "subscription"],
          label: "BLIK w aplikacji bankowej",
        },
      ],
    });

    expect(JSON.stringify(parsed)).not.toContain("payid_");
  });

  it("rejects raw provider payment refs in saved method summaries", () => {
    expect(() =>
      customerPaymentMethodsResponseSchema.parse({
        contractVersion: CUSTOMER_PAYMENT_METHODS_CONTRACT_VERSION,
        paymentMethods: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            provider: "tpay",
            methodKind: "blik_payid",
            status: "active",
            usableFor: ["one_time"],
            label: "BLIK",
            providerMethodRef: "payid_secret",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts hidden customer address and orderer summaries", () => {
    const parsed = customerAddressesResponseSchema.parse({
      contractVersion: CUSTOMER_ADDRESSES_CONTRACT_VERSION,
      ordererProfiles: [
        {
          profileId: "11111111-1111-4111-8111-111111111111",
          label: "Dom",
          fullName: "Jan Kowalski",
          email: "jan@example.com",
          phone: "+48500100100",
          companyName: null,
          taxId: null,
          isDefault: true,
          createdAt: "2026-06-06T12:00:00.000+02:00",
          updatedAt: "2026-06-06T12:00:00.000+02:00",
        },
      ],
      addresses: [
        {
          addressId: "22222222-2222-4222-8222-222222222222",
          kind: "shipping",
          label: "Dom",
          recipientName: "Jan Kowalski",
          contactPhone: "+48500100100",
          companyName: null,
          taxId: null,
          line1: "Testowa 12",
          line2: null,
          city: "Warszawa",
          postalCode: "00-001",
          country: "PL",
          isDefault: true,
          deliveryNotes: "Prosze zostawic przy ochronie.",
          courierInstructions: "Domofon 12.",
          lastUsedAt: null,
          createdAt: "2026-06-06T12:00:00.000+02:00",
          updatedAt: "2026-06-06T12:00:00.000+02:00",
        },
      ],
    });

    expect(parsed.addresses[0]?.courierInstructions).toBe("Domofon 12.");
  });

  it("rejects metadata, provider payloads, and oversized delivery notes", () => {
    expect(() =>
      customerAddressesResponseSchema.parse({
        contractVersion: CUSTOMER_ADDRESSES_CONTRACT_VERSION,
        ordererProfiles: [],
        addresses: [
          {
            addressId: "22222222-2222-4222-8222-222222222222",
            kind: "shipping",
            label: null,
            recipientName: null,
            contactPhone: null,
            companyName: null,
            taxId: null,
            line1: "Testowa 12",
            line2: null,
            city: "Warszawa",
            postalCode: "00-001",
            country: "PL",
            isDefault: true,
            deliveryNotes: "x".repeat(501),
            courierInstructions: null,
            lastUsedAt: null,
            createdAt: "2026-06-06T12:00:00.000+02:00",
            updatedAt: "2026-06-06T12:00:00.000+02:00",
            metadata: { selectedDelivery: "raw" },
            providerPayload: { dhl: "raw" },
          },
        ],
      }),
    ).toThrow();
  });
});
