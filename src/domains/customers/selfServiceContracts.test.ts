import { describe, expect, it } from "vitest";
import type { SubscriptionSelfServiceMutationResult } from "../subscription/ports.js";
import {
  CUSTOMER_ACCOUNT_CONTRACT_VERSION,
  CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
  type CustomerSubscriptionActionResponse,
  customerAccountResponseSchema,
  customerAddressUpsertRequestSchema,
  customerPetCreateRequestSchema,
  customerPetUpdateRequestSchema,
  customerProfileUpdateRequestSchema,
  customerSubscriptionActionResponseSchema,
  customerSubscriptionActionSchema,
} from "./selfServiceContracts.js";

describe("customer self-service contracts", () => {
  it("accepts the hidden account dashboard read model", () => {
    const parsed = customerAccountResponseSchema.parse({
      contractVersion: CUSTOMER_ACCOUNT_CONTRACT_VERSION,
      profile: {
        clientId: "11111111-1111-4111-8111-111111111111",
        email: "buyer@example.com",
        firstName: "Ala",
        lastName: null,
        phone: "+48500100100",
        lifecycleStage: "customer",
      },
      pets: [
        {
          petId: "22222222-2222-4222-8222-222222222222",
          petType: "dog",
          name: "Figa",
          breed: "mix",
          ageLabel: "3 lata",
          weightKg: 12.5,
          activityLevel: "normal",
          bodyCondition: "normal",
          allergies: ["chicken"],
          photoUrl: null,
          removedAt: null,
          createdAt: "2026-06-08T12:00:00.000+02:00",
          updatedAt: "2026-06-08T12:00:00.000+02:00",
        },
      ],
      subscriptions: [],
      addresses: [],
      ordererProfiles: [],
      paymentPreferences: [],
      recentOrders: [],
      events: [],
    });

    expect(parsed.profile.email).toBe("buyer@example.com");
    expect(parsed.pets[0]?.allergies).toEqual(["chicken"]);
  });

  it("keeps profile updates away from auth email changes", () => {
    expect(
      customerProfileUpdateRequestSchema.parse({
        idempotencyKey: "profile-update-1",
        firstName: "Ala",
        phone: "500 100 100",
      }),
    ).toEqual({
      idempotencyKey: "profile-update-1",
      firstName: "Ala",
      phone: "+48500100100",
    });

    expect(() =>
      customerProfileUpdateRequestSchema.parse({
        idempotencyKey: "profile-update-1",
        email: "new@example.com",
      }),
    ).toThrow();

    expect(() =>
      customerProfileUpdateRequestSchema.parse({
        idempotencyKey: "profile-update-1",
        firstName: "https://example.com",
      }),
    ).toThrow("forms:fields.name.invalid");

    expect(() =>
      customerProfileUpdateRequestSchema.parse({
        idempotencyKey: "profile-update-1",
        phone: "123",
      }),
    ).toThrow("forms:fields.phone.invalid");
  });

  it("supports dog-only MVP pet creation without provider payloads", () => {
    expect(
      customerPetCreateRequestSchema.parse({
        idempotencyKey: "pet-create-1",
        petType: "dog",
        name: "Figa",
        allergies: ["beef"],
      }),
    ).toMatchObject({ petType: "dog", name: "Figa" });

    expect(() =>
      customerPetCreateRequestSchema.parse({
        idempotencyKey: "pet-create-1",
        petType: "cat",
        name: "Mruk",
      }),
    ).toThrow();
  });

  it("requires canonical customer pet mutation values while preserving legacy reads", () => {
    expect(
      customerPetCreateRequestSchema.parse({
        idempotencyKey: "pet-create-2",
        petType: "dog",
        name: "Lidka",
        breed: "Kundelek",
        ageLabel: "senior",
        weightKg: "9",
        activityLevel: "normal",
        bodyCondition: "ideal",
        allergies: ["chicken", "salmon_oil"],
      }),
    ).toMatchObject({
      name: "Lidka",
      breed: "Kundelek",
      ageLabel: "senior",
      weightKg: 9,
      activityLevel: "normal",
      bodyCondition: "ideal",
      allergies: ["chicken", "salmon_oil"],
    });

    expect(() =>
      customerPetCreateRequestSchema.parse({
        idempotencyKey: "pet-create-3",
        petType: "dog",
        name: "Lidka",
        ageLabel: "3 lata",
      }),
    ).toThrow("forms:fields.petAge.invalid");

    expect(() =>
      customerPetCreateRequestSchema.parse({
        idempotencyKey: "pet-create-4",
        petType: "dog",
        name: "Lidka",
        activityLevel: "spacerowy",
      }),
    ).toThrow();

    expect(() =>
      customerPetCreateRequestSchema.parse({
        idempotencyKey: "pet-create-5",
        petType: "dog",
        name: "Lidka",
        bodyCondition: "normal",
      }),
    ).toThrow();

    expect(() =>
      customerPetUpdateRequestSchema.parse({
        idempotencyKey: "pet-update-1",
        petId: "22222222-2222-4222-8222-222222222222",
        allergies: ["Not A Slug!"],
      }),
    ).toThrow();
  });

  it("normalizes and validates customer address upserts with canonical field helpers", () => {
    expect(
      customerAddressUpsertRequestSchema.parse({
        idempotencyKey: "address-upsert-1",
        kind: "billing",
        recipientName: " Ada   Buyer ",
        contactPhone: "500 100 100",
        line1: "Prosta 1",
        city: "Warszawa",
        postalCode: "00001",
        country: "Polska",
        taxId: "123-456-32-18",
      }),
    ).toMatchObject({
      recipientName: "Ada Buyer",
      contactPhone: "+48500100100",
      postalCode: "00-001",
      country: "PL",
      taxId: "1234563218",
    });

    expect(
      customerAddressUpsertRequestSchema.parse({
        idempotencyKey: "address-upsert-2",
        kind: "shipping",
        companyName: "Should disappear",
        taxId: "123",
        line1: "Prosta 1",
        city: "Warszawa",
        postalCode: "00-001",
        country: "PL",
      }),
    ).toMatchObject({
      companyName: null,
      taxId: null,
    });

    expect(() =>
      customerAddressUpsertRequestSchema.parse({
        idempotencyKey: "address-upsert-3",
        kind: "billing",
        line1: "Prosta 1",
        city: "Warszawa",
        postalCode: "00-001",
        country: "PL",
        taxId: "123",
      }),
    ).toThrow("forms:fields.taxId.invalid");
  });

  it("validates subscription self-service actions and sanitized responses", () => {
    expect(
      customerSubscriptionActionSchema.parse({
        action: "slide_next_cycle",
        idempotencyKey: "slide-cycle-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        newNextCycleAt: "2026-06-20T12:00:00.000+02:00",
      }),
    ).toMatchObject({ action: "slide_next_cycle" });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "pause",
        idempotencyKey: "pause-cycle-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        pausePreset: "2_weeks",
      }),
    ).toMatchObject({ action: "pause", pausePreset: "2_weeks" });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "cancel",
        idempotencyKey: "cancel-cycle-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        survey: { reasonCode: "too_expensive", acceptedSaveOfferId: "pause-first" },
        saveOffer: { offerId: "pause-first", kind: "pause", accepted: true, externalOfferRef: "retention-provider:pause-first" },
      }),
    ).toMatchObject({ action: "cancel", survey: { reasonCode: "too_expensive" } });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "update_addon_quantity",
        idempotencyKey: "addon-qty-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        variantId: "44444444-4444-4444-8444-444444444444",
        qty: 3,
      }),
    ).toMatchObject({ action: "update_addon_quantity", qty: 3 });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "update_package_template",
        idempotencyKey: "package-template-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        planDays: 28,
        recipes: [{ variantId: "44444444-4444-4444-8444-444444444444", qty: 14 }],
        addons: [],
        expectedTemplateVersion: 2,
        acceptedQuoteHash: "a".repeat(64),
      }),
    ).toMatchObject({ action: "update_package_template", planDays: 28, acceptedQuoteHash: "a".repeat(64) });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "update_bundle",
        idempotencyKey: "bundle-update-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        coreLines: [{ variantId: "44444444-4444-4444-8444-444444444444", qty: 14 }],
        compositionConstraint: { kind: "feeding_days", value: 28, dailyKcalOverride: 300 },
        acceptedQuoteHash: "b".repeat(64),
      }),
    ).toMatchObject({ action: "update_bundle", coreLines: [{ isAddon: false }] });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "resize_bundle",
        idempotencyKey: "bundle-resize-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        resizeLever: { kind: "planLength", value: 21 },
        cadenceDays: 21,
        compositionConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 300 },
        acceptedQuoteHash: "c".repeat(64),
      }),
    ).toMatchObject({ action: "resize_bundle", cadenceDays: 21 });

    expect(() =>
      customerSubscriptionActionSchema.parse({
        action: "resize_bundle",
        idempotencyKey: "bundle-resize-envelope",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        resizeLever: { kind: "planLength", value: 21 },
        compositionConstraint: { kind: "petfood.kcal", version: 1, data: { value: 21 } },
        acceptedQuoteHash: "d".repeat(64),
      }),
    ).toThrow();

    expect(
      customerSubscriptionActionSchema.parse({
        action: "change_shipping_address",
        idempotencyKey: "address-change-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        shippingAddressId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toMatchObject({ action: "change_shipping_address" });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "order_now",
        idempotencyKey: "order-now-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        confirmedChargeTiming: true,
      }),
    ).toMatchObject({ action: "order_now", confirmedChargeTiming: true });

    expect(() =>
      customerSubscriptionActionSchema.parse({
        action: "order_now",
        idempotencyKey: "order-now-missing-confirmation",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toThrow();

    expect(
      customerSubscriptionActionSchema.parse({
        action: "reactivate",
        idempotencyKey: "reactivate-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        confirmedChargeTiming: true,
      }),
    ).toMatchObject({ action: "reactivate", confirmedChargeTiming: true });

    expect(
      customerSubscriptionActionSchema.parse({
        action: "pause",
        idempotencyKey: "pause-save-offer-1",
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        pausePreset: "2_weeks",
        survey: { reasonCode: "too_much_food", acceptedSaveOfferId: "pause-2_weeks" },
        saveOffer: { offerId: "pause-2_weeks", kind: "pause", accepted: true },
      }),
    ).toMatchObject({
      action: "pause",
      survey: { reasonCode: "too_much_food", acceptedSaveOfferId: "pause-2_weeks" },
      saveOffer: { kind: "pause", accepted: true },
    });

    expect(
      customerSubscriptionActionResponseSchema.parse({
        contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
        subscriptionAction: {
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          action: "pause",
          status: "applied",
          subscriptionStatus: "paused",
          nextCycleAt: "2026-06-20T12:00:00.000+02:00",
          templateVersion: 2,
          eventId: null,
        },
      }).subscriptionAction.subscriptionStatus,
    ).toBe("paused");

    expect(
      customerSubscriptionActionResponseSchema.parse({
        contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
        subscriptionAction: {
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          action: "update_addon_quantity",
          status: "noop",
          subscriptionStatus: "active",
          nextCycleAt: "2026-06-20T12:00:00.000+02:00",
          templateVersion: 2,
          eventId: null,
        },
      }).subscriptionAction.status,
    ).toBe("noop");

    expect(() =>
      customerSubscriptionActionResponseSchema.parse({
        contractVersion: CUSTOMER_SELF_SERVICE_CONTRACT_VERSION,
        subscriptionAction: {
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          action: "pause",
          status: "applied",
          subscriptionStatus: "paused",
          nextCycleAt: null,
          templateVersion: 2,
          eventId: null,
          paymentMethodRef: "pm_secret",
        },
      }),
    ).toThrow();
  });

  it("keeps the subscription mutation port aligned with the real apply response envelope", () => {
    const realApplyResponse = {} as CustomerSubscriptionActionResponse["subscriptionAction"];
    const portResult: SubscriptionSelfServiceMutationResult = realApplyResponse;
    const wireResult: CustomerSubscriptionActionResponse["subscriptionAction"] = portResult;
    expect(portResult).toBe(realApplyResponse);
    expect(wireResult).toBe(portResult);
  });
});
