import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_CONTRACT_VERSION } from "../../../src/domains/commerce/checkoutContracts.js";
import { CONFIGURATOR_INTENT_VERSION } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type {
  CommerceResumableOrderReadPort,
  ConfiguratorIntentPersistencePort,
} from "../../../src/domains/commerce/ports.js";
import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import type { CommerceCheckoutHandlerDeps } from "./commerceCheckoutHandler.js";
import { ConfiguratorIntentPersistenceConflictError } from "./configuratorIntentPersistenceHandler.js";
import {
  ADDRESS_ID,
  CLIENT_ID,
  PET_ID,
  createPorts,
  createResponse,
  intent,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

// W11.x latent-correctness fix: persistIntent (provision_identity) can raise a
// DETERMINISTIC idempotency conflict (same key, mutated payload — e.g. a resubmit
// whose volatile field shifted). It must NOT surface as a transient-looking 503;
// the client would just keep retrying. Instead: recover the already-minted
// identity and resume the in-flight order, or return a non-transient 409.

const RESUMABLE_ORDER_ID = "66666666-6666-4666-8666-666666666666";
const RESUMABLE_PI_ID = "77777777-7777-4777-8777-777777777777";

function completedIdentity(): ConfiguratorIntentPersistenceResponse {
  return {
    contractVersion: "commerce.configurator_intent_persistence.v1" as const,
    intentVersion: CONFIGURATOR_INTENT_VERSION,
    idempotencyKey: "intent-2026-06-05-rex",
    clientId: CLIENT_ID,
    petId: PET_ID,
    addressId: ADDRESS_ID,
    replayed: false,
  };
}

function conflictingPersistencePort(
  overrides: Partial<ConfiguratorIntentPersistencePort> = {},
): ConfiguratorIntentPersistencePort {
  return {
    persistIntent: vi.fn(async () => {
      throw new ConfiguratorIntentPersistenceConflictError(
        "Configurator intent persistence conflict",
        { code: "23505" },
      );
    }),
    findCompletedIdentity: vi.fn(async () => completedIdentity()),
    ...overrides,
  };
}

function resumablePort(
  result: Awaited<ReturnType<CommerceResumableOrderReadPort["findResumableOrderForClient"]>>,
): CommerceResumableOrderReadPort {
  return { findResumableOrderForClient: vi.fn(async () => result) };
}

function deps(overrides: Partial<CommerceCheckoutHandlerDeps> = {}): CommerceCheckoutHandlerDeps {
  return {
    ...createPorts(),
    persistencePort: conflictingPersistencePort(),
    resumableOrderPort: resumablePort(null),
    ...overrides,
  };
}

describe("commerce checkout handler — provision-identity conflict", () => {
  it("resumes the client's in-flight order on conflict (NOT 503)", async () => {
    const res = createResponse();
    const ports = deps({
      resumableOrderPort: resumablePort({
        orderId: RESUMABLE_ORDER_ID,
        paymentIntentId: RESUMABLE_PI_ID,
        status: "processing",
        // TRUE here on purpose, and it must still resume. This path is a
        // double-submit race, so the in-flight order IS this journey's — that is
        // what makes resuming the duplicate-charge guard rather than a stale
        // re-offer. The cart-change barriers deliberately do not apply without a
        // fresh quote to compare against, and there is none before persist.
        sameJourney: true,
        metadata: { selectedDelivery: intent().selectedDelivery },
      }),
    });

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    // Identity recovered for the conflicting key, resume keyed by that clientId.
    expect(vi.mocked(ports.persistencePort.findCompletedIdentity!)).toHaveBeenCalledWith(
      intent().idempotencyKey,
    );
    expect(vi.mocked(ports.resumableOrderPort!.findResumableOrderForClient)).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: CLIENT_ID }),
    );
    // The order-creation saga must be SKIPPED — no second order, no second charge.
    expect(vi.mocked(ports.orderDraftPort.createOrderDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          orderId: RESUMABLE_ORDER_ID,
          status: "processing",
          clientAction: { kind: "none" },
        }),
        meta: { contractVersion: CHECKOUT_CONTRACT_VERSION },
      }),
    );
  });

  it("returns a non-transient 409 on conflict when nothing is resumable", async () => {
    const res = createResponse();
    const ports = deps({ resumableOrderPort: resumablePort(null) });

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.orderDraftPort.createOrderDraft)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CONFLICT",
          details: expect.objectContaining({
            stage: "provision_identity",
            reason: "checkout_already_submitted",
          }),
        }),
      }),
    );
  });

  it("returns 409 (not 503) when the identity cannot be recovered", async () => {
    const res = createResponse();
    const ports = deps({
      persistencePort: conflictingPersistencePort({
        findCompletedIdentity: vi.fn(async () => null),
      }),
    });

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(vi.mocked(ports.resumableOrderPort!.findResumableOrderForClient)).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("returns 409 (not 503) when the identity lookup itself throws (fail-safe)", async () => {
    const res = createResponse();
    const ports = deps({
      persistencePort: conflictingPersistencePort({
        findCompletedIdentity: vi.fn(async () => {
          throw new Error("supabase unreachable");
        }),
      }),
    });

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "CONFLICT" }),
      }),
    );
  });

  it("still returns 503 for a genuine (non-conflict) persistence failure (regression)", async () => {
    const res = createResponse();
    const ports = deps({
      persistencePort: {
        persistIntent: vi.fn(async () => {
          throw new Error("Configurator intent persistence RPC failed: upstream down");
        }),
      },
    });

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent() }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "UPSTREAM_UNAVAILABLE",
          details: expect.objectContaining({ stage: "provision_identity" }),
        }),
      }),
    );
  });
});
