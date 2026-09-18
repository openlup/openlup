import { describe, expect, it, vi } from "vitest";
import { CONFIGURATOR_INTENT_VERSION } from "./configuratorIntentContracts";
import { CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION } from "./configuratorIntentPersistenceContracts";
import { persistConfiguratorIntent } from "./commerceClient";

describe("hidden commerce intent client", () => {
  it("persists configurator intents through the typed BFF client", async () => {
    const fetcher = createFetcher({
      contractVersion: CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION,
      intentVersion: CONFIGURATOR_INTENT_VERSION,
      idempotencyKey: "intent-2026-06-05-rex",
      clientId: "11111111-1111-4111-8111-111111111111",
      petId: "22222222-2222-4222-8222-222222222222",
      addressId: "33333333-3333-4333-8333-333333333333",
      clientMatchReason: "client_match_exact_email",
      replayed: false,
    });

    await expect(persistConfiguratorIntent(intent(), { fetcher })).resolves.toMatchObject({
      clientId: "11111111-1111-4111-8111-111111111111",
      clientMatchReason: "client_match_exact_email",
      replayed: false,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/configurator-intent",
      expect.objectContaining({ method: "POST", body: JSON.stringify(intent()) }),
    );
  });
});

function intent() {
  return {
    version: CONFIGURATOR_INTENT_VERSION as typeof CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    locale: "pl" as const,
    mode: "subscription" as const,
    cadenceDays: 21 as const,
    sizeConstraint: { kind: "feeding_days" as const, value: 21, dailyKcalOverride: 328 },
    petProfile: {
      name: "Rex",
      ageBand: "adult" as const,
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal" as const,
      bcs: "ideal" as const,
      allergenSlugs: ["chicken" as const],
      dailyKcalOverride: 328,
    },
    contact: { firstName: "Anna", lastName: "Kowalska", email: "anna@example.com", phone: "+48123456789" },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" as const },
    selectedDelivery: { kind: "courier" as const, providerRef: null },
    selectedFlavorSlugs: ["lamb" as const],
    selectedVariants: [{ variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb" as const, qty: 14 }],
    consents: { gdpr: true as const, marketing: false, terms: true as const },
    paymentMethodIntent: { method: "card" as const, saveForSubscription: true },
    consciousAllergenOverride: false,
  };
}

function createFetcher(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  });
}
