import type { z } from "zod";
import { CommerceOrderDraftConflictError, CommerceOrderDraftInvalidResponseError, CommerceOrderDraftPersistenceError } from "../errors.js";
import { CommerceOrderDraftPriceChangedError } from "../orderDraftErrors.js";
import type { CommerceOrderDraftWritePort, CreateOrderDraftOptions } from "../contracts/ports.js";
import type { RpcError as SupabaseRpcError } from "../contracts/omsTypes.js";
import { ORDER_DRAFT_RPC_NAME } from "./orderDraftRpcPayload.js";

/** Companion RPC that supersedes a stale pre-payment draft for a stable journey key. */
export const ORDER_DRAFT_SUPERSEDE_RPC_NAME =
  "commerce_supersede_pre_payment_order_draft" as const;

export interface CommerceOrderDraftRpcClient<Args extends Record<string, unknown>> {
  rpc(
    functionName: typeof ORDER_DRAFT_RPC_NAME,
    args: Args,
  ): PromiseLike<{ data: unknown; error: SupabaseRpcError | null }>;
  rpc(
    functionName: typeof ORDER_DRAFT_SUPERSEDE_RPC_NAME,
    args: { p_idempotency_key: string },
  ): PromiseLike<{ data: unknown; error: SupabaseRpcError | null }>;
}

export function createSupabaseCommerceOrderDraftPort<Request extends { idempotencyKey: string }, Response, Args extends Record<string, unknown>>(
  client: CommerceOrderDraftRpcClient<Args>,
  bindings: { createOrderDraftRpcArgs(request: Request, clientId: string | null): Args; responseSchema: z.ZodType<Response> },
): CommerceOrderDraftWritePort<Request, Response> {
  return {
    async createOrderDraft(
      request: Request,
      options?: CreateOrderDraftOptions,
    ): Promise<Response> {
      const args = bindings.createOrderDraftRpcArgs(request, options?.clientId ?? null);
      let response = await client.rpc(ORDER_DRAFT_RPC_NAME, args);

      // Stable journey key + edited cart: the producer keys the draft by
      // idempotencyKey and 23505s when the same key arrives with a different
      // (frozen-money) snapshot. Canonical order money freezes an order's amounts
      // once written, so the stale draft cannot be mutated in place — supersede it
      // (cancel the unpaid draft, drop the key) and retry create ONCE via the
      // order-draft supersede RPC. If nothing was superseded (funds already moved),
      // the conflict stands and the caller's resume path owns the in-flight order.
      if (response.error && isIdempotencyConflict(response.error)) {
        const superseded = await supersedeStalePrePaymentDraft(
          client,
          request.idempotencyKey,
        );
        if (superseded) {
          response = await client.rpc(ORDER_DRAFT_RPC_NAME, args);
        }
      }

      if (response.error) throw mapRpcError(response.error);

      const parsed = bindings.responseSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new CommerceOrderDraftInvalidResponseError();
      }

      return parsed.data;
    },
  };
}

/**
 * Best-effort supersede of a stale pre-payment draft for this idempotency key.
 * Any failure returns false so the original conflict is preserved (fail-closed to
 * the existing conflict path — never masks a real error as a fresh draft).
 */
async function supersedeStalePrePaymentDraft<Args extends Record<string, unknown>>(
  client: CommerceOrderDraftRpcClient<Args>,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc(ORDER_DRAFT_SUPERSEDE_RPC_NAME, {
      p_idempotency_key: idempotencyKey,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

function mapRpcError(error: SupabaseRpcError): Error {
  const catalogReason = ["commerce_order_draft_catalog_head_moved", "commerce_order_draft_catalog_anchor_missing", "commerce_order_draft_offer_membership_refused"]
    .find((reason) => [error.message, error.details, error.hint].some((value) => value?.includes(reason)));
  if (catalogReason) return new CommerceOrderDraftConflictError("Commerce catalog admission changed", {
    reason: catalogReason, code: error.code, boundary: ORDER_DRAFT_RPC_NAME,
  });
  if (isPromotionPriceChanged(error)) {
    return new CommerceOrderDraftPriceChangedError(
      "Commerce order draft promotion changed",
      {
        code: error.code,
        boundary: ORDER_DRAFT_RPC_NAME,
        reason: "promotion_code_unavailable",
      },
    );
  }
  if (isIdempotencyConflict(error)) {
    return new CommerceOrderDraftConflictError("Commerce order draft idempotency conflict", {
      code: error.code,
      boundary: ORDER_DRAFT_RPC_NAME,
    });
  }

  return new CommerceOrderDraftPersistenceError("Commerce order draft RPC failed", {
    code: error.code,
    boundary: ORDER_DRAFT_RPC_NAME,
  });
}

function isPromotionPriceChanged(error: SupabaseRpcError): boolean {
  const searchable = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  return [
    "promotion_code_global_limit_reached",
    "promotion_code_customer_limit_reached",
    "promotion_code_not_active",
    "promotion_code_not_found",
    "promotion_code_definition_changed",
    "promotion_code_snapshot_revision_mismatch",
  ].some((reason) => searchable.includes(reason));
}

function isIdempotencyConflict(error: SupabaseRpcError): boolean {
  const searchable = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  return (
    error.code === "23505" ||
    searchable.includes("commerce_order_draft_idempotency_conflict")
  );
}
