import {
  createOrderDraftResponseSchema,
  type CreateOrderDraftRequest,
  type CreateOrderDraftResponse,
} from "../../../src/domains/commerce/contracts.js";
import {
  checkoutResumeDraftSchema,
  type CheckoutResumeDraft,
} from "../../../src/domains/commerce/checkoutResumeContracts.js";
import {
  CommerceCheckoutResumePersistenceError,
  CommerceOrderDraftConflictError,
  CommerceOrderDraftInvalidResponseError,
  CommerceOrderDraftPersistenceError,
  CommerceOrderDraftPriceChangedError,
  CommerceOrderDraftUnsupportedMoneyError,
  type CommerceCheckoutResumeDraftPort,
  type CommerceOrderDraftWritePort,
  type CreateOrderDraftOptions,
} from "../../../src/domains/commerce/ports.js";
import { createOrderDraftRpcArgs } from "../../domains/commerce/orderDraftRpcPayload.js";
import { PgGatewayClient, type PgQueryExecutor } from "./queryBuilder.js";

const ORDER_DRAFT_RPC = "commerce_create_promoted_order_draft_with_outbox";
const RESUME_UPSERT_RPC = "commerce_checkout_resume_upsert";
const RESUME_READ_RPC = "commerce_checkout_resume_read";

type RpcError = { code?: string; details?: string; hint?: string; message?: string };

export function createPostgresCommerceOrderJourneyPorts(
  executor: PgQueryExecutor,
): {
  orderDraftPort: CommerceOrderDraftWritePort;
  resumePort: CommerceCheckoutResumeDraftPort;
} {
  const gateway = new PgGatewayClient(executor);
  return {
    orderDraftPort: createOrderDraftPort(gateway),
    resumePort: createResumePort(gateway),
  };
}

function createOrderDraftPort(gateway: PgGatewayClient): CommerceOrderDraftWritePort {
  return {
    async createOrderDraft(
      request: CreateOrderDraftRequest,
      options?: CreateOrderDraftOptions,
    ): Promise<CreateOrderDraftResponse> {
      const response = await gateway.rpc(
        ORDER_DRAFT_RPC,
        createOrderDraftRpcArgs(request, options?.clientId ?? null),
      );
      if (response.error) throw mapOrderDraftError(response.error);
      const parsed = createOrderDraftResponseSchema.safeParse(response.data);
      if (!parsed.success) throw new CommerceOrderDraftInvalidResponseError();
      return parsed.data;
    },
  };
}

function createResumePort(gateway: PgGatewayClient): CommerceCheckoutResumeDraftPort {
  return {
    async upsertDraft(input): Promise<CheckoutResumeDraft> {
      const response = await gateway.rpc(RESUME_UPSERT_RPC, {
        p_token_hash: input.tokenHash,
        p_idempotency_key_hash: input.idempotencyKeyHash,
        p_last_section_id: input.lastSectionId,
        p_draft_state: input.draftState,
        p_expires_at: input.expiresAt,
        p_now: input.now,
      });
      if (response.error) throw mapResumeError(response.error);
      return parseResume(response.data);
    },
    async readDraftByTokenHash(input): Promise<CheckoutResumeDraft | null> {
      const response = await gateway.rpc(RESUME_READ_RPC, {
        p_token_hash: input.tokenHash,
        p_now: input.now,
      });
      if (response.error) throw mapResumeError(response.error);
      if (response.data === null) return null;
      return parseResume(response.data);
    },
  };
}

function parseResume(value: unknown): CheckoutResumeDraft {
  const parsed = checkoutResumeDraftSchema.safeParse(value);
  if (!parsed.success) {
    throw new CommerceCheckoutResumePersistenceError(
      "Checkout resume draft response invalid",
      { boundary: RESUME_READ_RPC },
    );
  }
  return parsed.data;
}

function mapOrderDraftError(error: RpcError): Error {
  const message = searchable(error);
  if (error.code === "23505" || message.includes("commerce_order_draft_idempotency_conflict")) {
    return new CommerceOrderDraftConflictError(undefined, {
      code: error.code,
      boundary: ORDER_DRAFT_RPC,
    });
  }
  if (message.includes("commerce_order_draft_catalog_price_changed")) {
    return new CommerceOrderDraftPriceChangedError(
      "Commerce order draft catalog price changed",
      { code: error.code, boundary: ORDER_DRAFT_RPC, reason: "catalog_price_changed" },
    );
  }
  if (message.includes("commerce_promotion_line_allocation_unsupported")) {
    return new CommerceOrderDraftUnsupportedMoneyError("line_promotion_unsupported");
  }
  if (message.includes("commerce_promoted_net_shipping_unsupported")) {
    return new CommerceOrderDraftUnsupportedMoneyError("net_shipping_unsupported");
  }
  if (message.includes("commerce_zero_payable_order_unsupported")) {
    return new CommerceOrderDraftUnsupportedMoneyError("zero_payable_unsupported");
  }
  return new CommerceOrderDraftPersistenceError("Commerce order draft RPC failed", {
    code: error.code,
    boundary: ORDER_DRAFT_RPC,
  });
}

function mapResumeError(error: RpcError): Error {
  return new CommerceCheckoutResumePersistenceError(
    "Checkout resume draft persistence failed",
    { code: error.code, boundary: "commerce_checkout_resume_drafts" },
  );
}

function searchable(error: RpcError): string {
  return [error.message, error.details, error.hint].filter(Boolean).join(" ");
}
