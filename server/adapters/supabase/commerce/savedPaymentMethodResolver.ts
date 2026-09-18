import type { CheckoutSavedPaymentMethodResolverPort } from "../../../domains/commerce/savedPaymentMethodResolverPort.js";

interface RpcError {
  code?: string;
  message?: string;
}

interface SupabaseAuthUser {
  id?: string | null;
}

interface SavedMethodQueryBuilder {
  eq(column: string, value: unknown): SavedMethodQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface SavedMethodTable {
  select(columns: string): SavedMethodQueryBuilder;
}

export interface SavedPaymentMethodSupabaseClient {
  auth: {
    getUser(accessToken: string): PromiseLike<{
      data: { user: SupabaseAuthUser | null };
      error: RpcError | null;
    }>;
  };
  from(table: string): SavedMethodTable;
}

export function createSupabaseSavedPaymentMethodResolver(
  client: SavedPaymentMethodSupabaseClient,
): CheckoutSavedPaymentMethodResolverPort {
  return {
    async resolveSavedPaymentMethod(input) {
      if (!input.accessToken) return null;

      const { data: authData, error: authError } = await client.auth.getUser(input.accessToken);
      const userId = typeof authData.user?.id === "string" ? authData.user.id : null;
      if (authError || !userId) return null;

      const { data: clientRow, error: clientError } = await client
        .from("clients")
        .select("id")
        .eq("id", input.clientId)
        .eq("auth_user_id", userId)
        .maybeSingle();
      if (clientError) throw new Error(`saved payment method client lookup failed: ${clientError.message ?? clientError.code ?? "failed"}`);
      if (!clientRow || typeof clientRow !== "object") return null;

      const { data: methodRow, error: methodError } = await client
        .from("commerce_payment_method_refs")
        .select("id,provider_kind,method_kind,provider_method_ref,status,active,expires_at,consent_snapshot,raw_provider_payload")
        .eq("id", input.savedMethodId)
        .eq("client_id", input.clientId)
        .eq("provider_kind", "tpay")
        .eq("method_kind", "blik_payid")
        .eq("status", "active")
        .eq("active", true)
        .maybeSingle();
      if (methodError) throw new Error(`saved payment method lookup failed: ${methodError.message ?? methodError.code ?? "failed"}`);
      if (!methodRow || typeof methodRow !== "object") return null;

      const row = methodRow as Record<string, unknown>;
      const expiresAt = readNullableString(row, "expires_at");
      if (expiresAt && Date.parse(expiresAt) <= input.now.getTime()) return null;

      const providerMethodRef = readString(row, "provider_method_ref");
      const providerAliasType = readAliasType(row) ?? "PAYID";
      const recurringModel = readRecurringModel(row);
      if (input.requestedFlow === "blik_recurring_saved" && providerAliasType !== "PAYID") {
        return null;
      }
      if (input.requestedFlow === "blik_recurring_saved" && recurringModel !== "O") {
        return null;
      }
      return {
        providerMethodRef,
        providerAliasType,
        ...(recurringModel ? { recurringModel } : {}),
      };
    },
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Saved payment method response invalid");
  }
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readAliasType(value: Record<string, unknown>): "UID" | "PAYID" | null {
  const rawPayload = readRecord(value.raw_provider_payload);
  const consentSnapshot = readRecord(value.consent_snapshot);
  const candidates = [
    rawPayload?.aliasType,
    rawPayload?.["msg_value[type]"],
    consentSnapshot?.aliasType,
  ];
  for (const candidate of candidates) {
    if (candidate === "UID" || candidate === "PAYID") return candidate;
  }
  return null;
}

function readRecurringModel(value: Record<string, unknown>): "O" | "M" | undefined {
  const model = readRecord(value.consent_snapshot)?.recurringModel;
  return model === "O" || model === "M" ? model : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
