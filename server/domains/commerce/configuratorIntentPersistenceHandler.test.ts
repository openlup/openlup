import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
  CONFIGURATOR_INTENT_VERSION,
} from "../../../src/domains/commerce/configuratorIntentContracts.js";
import {
  CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION,
  type ConfiguratorIntentPersistenceResponse,
} from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { ConfiguratorIntentPersistencePort } from "../../../src/domains/commerce/ports.js";
import {
  ConfiguratorIntentPersistenceConflictError,
  createConfiguratorIntentPersistenceHandler,
} from "./configuratorIntentPersistenceHandler.js";

describe("configurator intent persistence handler", () => {
  it("persists hidden configurator intents through the shared envelope", async () => {
    const port = createPort();
    const res = createResponse();

    await createConfiguratorIntentPersistenceHandler({ persistencePort: port })(
      request("POST", intent()),
      res,
    );

    expect(port.persistIntent).toHaveBeenCalledWith({
      ...intent(),
      promoCodes: [],
      selectedDelivery: { ...intent().selectedDelivery, deliveryKind: "courier" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: response(false),
      meta: { contractVersion: CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION },
    });
  });

  it("rejects unsupported methods and invalid intents", async () => {
    const method = createResponse();
    await createConfiguratorIntentPersistenceHandler({ persistencePort: createPort() })(
      request("GET"),
      method,
    );

    const invalid = createResponse();
    await createConfiguratorIntentPersistenceHandler({ persistencePort: createPort() })(
      request("POST", { ...intent(), cadenceDays: null }),
      invalid,
    );

    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("preserves an in-flight legacy v1 cadence through persistence", async () => {
    const legacyIntent = intent({
      cadencePolicyVersion: undefined,
      cadenceDays: 30,
    });
    const legacyResponse = response(false);
    const port = createPort(legacyResponse);
    const res = createResponse();

    await createConfiguratorIntentPersistenceHandler({ persistencePort: port })(
      request("POST", legacyIntent),
      res,
    );

    expect(port.persistIntent).toHaveBeenCalledWith(expect.objectContaining({
      version: CONFIGURATOR_INTENT_VERSION,
      cadenceDays: 30,
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ intentVersion: CONFIGURATOR_INTENT_VERSION }),
    }));
  });

  it("maps idempotency conflicts and invalid port responses", async () => {
    const conflict = createResponse();
    await createConfiguratorIntentPersistenceHandler({
      persistencePort: createPort(new ConfiguratorIntentPersistenceConflictError()),
    })(request("POST", intent()), conflict);

    const invalid = createResponse();
    await createConfiguratorIntentPersistenceHandler({
      persistencePort: createPort({ ...response(false), clientId: "bad" }),
    })(request("POST", intent()), invalid);

    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(invalid.status).toHaveBeenCalledWith(502);
  });
});

function createPort(result?: unknown): ConfiguratorIntentPersistencePort {
  return {
    persistIntent: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return (result as ConfiguratorIntentPersistenceResponse | undefined) ?? response(false);
    }),
  };
}

function response(
  replayed: boolean,
  intentVersion: ConfiguratorIntentPersistenceResponse["intentVersion"] = CONFIGURATOR_INTENT_VERSION,
): ConfiguratorIntentPersistenceResponse {
  return {
    contractVersion: CONFIGURATOR_INTENT_PERSISTENCE_CONTRACT_VERSION,
    intentVersion,
    idempotencyKey: "intent-2026-06-05-rex",
    clientId: "11111111-1111-4111-8111-111111111111",
    petId: "22222222-2222-4222-8222-222222222222",
    addressId: "33333333-3333-4333-8333-333333333333",
    replayed,
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    version: CONFIGURATOR_INTENT_VERSION,
    cadencePolicyVersion: CONFIGURATOR_FIXED_CADENCE_POLICY_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    locale: "pl",
    mode: "subscription",
    cadenceDays: 21,
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 },
    petProfile: {
      name: "Rex",
      ageBand: "adult",
      breed: "labrador",
      weightKg: 12,
      activityLevel: "normal",
      bcs: "ideal",
      allergenSlugs: ["chicken"],
      dailyKcalOverride: 328,
    },
    contact: { firstName: "Anna", lastName: "Kowalska", email: "anna@example.com", phone: "+48123456789" },
    address: { street: "Testowa 12", postalCode: "00-001", city: "Warszawa", country: "PL" },
    selectedDelivery: { kind: "courier", providerRef: null },
    selectedFlavorSlugs: ["lamb"],
    selectedVariants: [{ variantId: "variant-lamb-400", sku: "opaque:lamb-launch.v1", flavorSlug: "lamb", qty: 14 }],
    consents: { gdpr: true, marketing: false, terms: true },
    paymentMethodIntent: { method: "card", saveForSubscription: true },
    consciousAllergenOverride: false,
    ...overrides,
  };
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
