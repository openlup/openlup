import { describe, expect, it, vi } from "vitest";

import { CHECKOUT_RESUME_CONTRACT_VERSION } from "../../../src/domains/commerce/checkoutResumeContracts.js";
import {
  CommerceCheckoutResumePersistenceError,
  CommerceOrderDraftConflictError,
  CommerceOrderDraftPriceChangedError,
  type CommerceCheckoutResumeDraftUpsertInput,
} from "../../../src/domains/commerce/ports.js";
import { quoteSnapshot } from "../../domains/commerce/commerceCheckoutHandler.testFixtures.js";
import { createPostgresCommerceOrderJourneyPorts } from "./commerceOrderJourney.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const RESUME_ID = "22222222-2222-4222-8222-222222222222";

describe("postgres commerce order journey", () => {
  it("maps the atomic order-draft response and passes parameterized RPC arguments", async () => {
    const executor = respondingExecutor({
      commerce_create_promoted_order_draft_with_outbox: orderResponse(false),
    });
    const ports = createPostgresCommerceOrderJourneyPorts(executor);

    await expect(ports.orderDraftPort.createOrderDraft(request())).resolves.toEqual(
      orderResponse(false),
    );
    expect(executor.query).toHaveBeenCalledWith(
      expect.stringContaining('"commerce_create_promoted_order_draft_with_outbox"'),
      expect.arrayContaining(["order-draft-idempotency-1", quoteSnapshot()]),
    );
  });

  it("preserves replay and maps changed-command conflicts", async () => {
    const replay = createPostgresCommerceOrderJourneyPorts(respondingExecutor({
      commerce_create_promoted_order_draft_with_outbox: orderResponse(true),
    }));
    await expect(replay.orderDraftPort.createOrderDraft(request())).resolves.toMatchObject({
      orderDraft: { orderId: `order_${ORDER_ID}`, replayed: true },
    });

    const conflict = createPostgresCommerceOrderJourneyPorts(errorExecutor(
      "23505",
      "commerce_order_draft_idempotency_conflict",
    ));
    await expect(conflict.orderDraftPort.createOrderDraft(request())).rejects.toBeInstanceOf(
      CommerceOrderDraftConflictError,
    );
  });

  it("maps catalog price refusal without fabricating a draft", async () => {
    const ports = createPostgresCommerceOrderJourneyPorts(errorExecutor(
      "22023",
      "commerce_order_draft_catalog_price_changed",
    ));
    await expect(ports.orderDraftPort.createOrderDraft(request())).rejects.toBeInstanceOf(
      CommerceOrderDraftPriceChangedError,
    );
  });

  it("upserts and reads the same redacted resume projection", async () => {
    const executor = respondingExecutor({
      commerce_checkout_resume_upsert: resumeDraft(false),
      commerce_checkout_resume_read: resumeDraft(true),
    });
    const ports = createPostgresCommerceOrderJourneyPorts(executor);
    const input = resumeInput();

    await expect(ports.resumePort.upsertDraft(input)).resolves.toEqual(resumeDraft(false));
    await expect(ports.resumePort.readDraftByTokenHash({
      tokenHash: input.tokenHash,
      now: input.now,
    })).resolves.toEqual(resumeDraft(true));
    expect(executor.query).toHaveBeenCalledTimes(2);
  });

  it("returns missing reads and rejects malformed resume responses", async () => {
    const missing = createPostgresCommerceOrderJourneyPorts(respondingExecutor({
      commerce_checkout_resume_read: null,
    }));
    await expect(missing.resumePort.readDraftByTokenHash({
      tokenHash: "a".repeat(64),
      now: "2026-08-13T10:00:00.000Z",
    })).resolves.toBeNull();

    const malformed = createPostgresCommerceOrderJourneyPorts(respondingExecutor({
      commerce_checkout_resume_upsert: { contractVersion: "wrong" },
    }));
    await expect(malformed.resumePort.upsertDraft(resumeInput())).rejects.toBeInstanceOf(
      CommerceCheckoutResumePersistenceError,
    );
  });
});

function request() {
  return { idempotencyKey: "order-draft-idempotency-1", quoteSnapshot: quoteSnapshot() };
}

function orderResponse(replayed: boolean) {
  return {
    contractVersion: "commerce.v0" as const,
    orderDraft: {
      orderId: `order_${ORDER_ID}`,
      status: "draft" as const,
      paymentStatus: "not_started" as const,
      idempotencyKey: "order-draft-idempotency-1",
      quoteSnapshot: quoteSnapshot(),
      replayed,
    },
  };
}

function resumeInput(): CommerceCheckoutResumeDraftUpsertInput {
  return {
    tokenHash: "a".repeat(64),
    idempotencyKeyHash: "b".repeat(64),
    lastSectionId: "product_selection" as const,
    draftState: {
      version: CHECKOUT_RESUME_CONTRACT_VERSION,
      mode: "one_time" as const,
      cadenceDays: null,
      cart: { items: [{ sku: "opaque:lamb-launch.v1", productSlug: "lamb", variantId: null, quantity: 1 }] },
      completion: {
        petProfile: false, productSelection: true, cadence: false, account: false,
        shipping: false, billing: false, payment: false, review: false,
      },
      redactedFields: ["contact" as const],
    },
    expiresAt: "2026-08-13T12:00:00.000Z",
    now: "2026-08-13T10:00:00.000Z",
  };
}

function resumeDraft(replayed: boolean) {
  const input = resumeInput();
  return {
    id: RESUME_ID,
    contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
    lastSectionId: input.lastSectionId,
    draftState: input.draftState,
    expiresAt: input.expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
    replayed,
  };
}

function respondingExecutor(
  responses: Record<string, unknown>,
): PgQueryExecutor & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (text: string) => {
    const name = Object.keys(responses).find((candidate) => text.includes(candidate));
    if (!name) throw new Error("unexpected_query");
    return { rows: [{ [name]: responses[name] }] };
  });
  return { query };
}

function errorExecutor(code: string, message: string): PgQueryExecutor {
  return {
    query: vi.fn().mockRejectedValue(Object.assign(new Error(message), { code })),
  };
}
