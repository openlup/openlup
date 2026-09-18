import {
  hashCheckoutRecoveryToken,
  type CheckoutRecoveryTokenContext,
  type CheckoutRecoveryTokenInspection,
  type CheckoutRecoveryTokenPort,
} from "../../../domains/commerce/checkoutRecoveryToken.js";

interface RpcError {
  code?: string;
  message?: string;
}

export interface CheckoutRecoveryTokenSupabaseClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/**
 * Supabase-backed checkout-recovery token port (service-role). Calls the two
 * SECURITY DEFINER RPCs from 20260707100000_commerce_checkout_recovery_tokens.sql.
 */
export function createSupabaseCheckoutRecoveryTokenPort(
  client: CheckoutRecoveryTokenSupabaseClient,
): CheckoutRecoveryTokenPort {
  return {
    async issue({ orderId, rawToken, expiresAt }): Promise<string> {
      const { data, error } = await client.rpc("commerce_checkout_recovery_token_issue", {
        p_order_id: orderId,
        p_token_hash: hashCheckoutRecoveryToken(rawToken),
        p_expires_at: expiresAt,
      });
      if (error) {
        throw new Error(
          `commerce_checkout_recovery_token_issue failed: ${error.message ?? error.code ?? "failed"}`,
        );
      }
      if (typeof data !== "string" || data.length === 0) {
        throw new Error("commerce_checkout_recovery_token_issue returned no token id");
      }
      return data;
    },

    async validate(rawToken, now): Promise<CheckoutRecoveryTokenContext | null> {
      const args: Record<string, unknown> = {
        p_token_hash: hashCheckoutRecoveryToken(rawToken),
      };
      if (now) args.p_now = now.toISOString();
      const { data, error } = await client.rpc("commerce_checkout_recovery_token_validate", args);
      if (error) {
        throw new Error(
          `commerce_checkout_recovery_token_validate failed: ${error.message ?? error.code ?? "failed"}`,
        );
      }
      // The RPC returns a set; PostgREST gives an array. No row ⇒ invalid token.
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      return {
        tokenId: readString(record, "token_id"),
        orderId: readString(record, "order_id"),
        clientId: readString(record, "client_id"),
        mode: readString(record, "mode"),
        status: readString(record, "status"),
      };
    },

    async inspect(rawToken, now): Promise<CheckoutRecoveryTokenInspection | null> {
      const args: Record<string, unknown> = {
        p_token_hash: hashCheckoutRecoveryToken(rawToken),
      };
      if (now) args.p_now = now.toISOString();
      const { data, error } = await client.rpc("commerce_checkout_recovery_token_inspect", args);
      if (error) {
        throw new Error(
          `commerce_checkout_recovery_token_inspect failed: ${error.message ?? error.code ?? "failed"}`,
        );
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      return {
        tokenId: readString(record, "token_id"),
        orderId: readString(record, "order_id"),
        clientId: readString(record, "client_id"),
        mode: readOptionalString(record, "mode"),
        status: readOptionalString(record, "status"),
        subscriptionId: readOptionalString(record, "subscription_id"),
        tokenState: readString(record, "token_state"),
      };
    },
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("commerce_checkout_recovery_token_validate response invalid");
  }
  return raw;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("commerce_checkout_recovery_token_inspect response invalid");
  }
  return raw.length > 0 ? raw : null;
}
