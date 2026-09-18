import {
  PaymentRecoveryRecordError,
  type SubscriptionPaymentRecoveryInput,
  type SubscriptionPaymentRecoverySetupPort,
  type SubscriptionRecoveryTokenEvidence as PaymentRecoveryTokenEvidence,
} from "../../../domains/subscription/paymentRecoveryPorts.js";
import { recordSubscriptionPaymentRecoveryResponseSchema } from "../../../../src/domains/subscription/contracts.js";

export interface PaymentRecoveryQueryBuilder {
  eq(column: string, value: unknown): PaymentRecoveryQueryBuilder;
  order(column: string, options?: { ascending?: boolean }): PaymentRecoveryQueryBuilder;
  limit(count: number): PaymentRecoveryQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface PaymentRecoverySupabaseClient {
  from(table: string): {
    select(columns: string): PaymentRecoveryQueryBuilder;
  };
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
}

export function createSupabaseSubscriptionRecoveryPort(
  client: PaymentRecoverySupabaseClient,
): SubscriptionPaymentRecoverySetupPort {
  return {
    async findTokenEvidenceByHash(tokenHash: string): Promise<PaymentRecoveryTokenEvidence | null> {
      const { data: token, error: tokenError } = await client
        .from("subscription_payment_recovery_tokens")
        .select("id, case_id, client_id, purpose, expires_at, used_at, revoked_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (tokenError) throw new Error(`subscription_payment_recovery_tokens lookup failed: ${tokenError.message ?? tokenError.code ?? "failed"}`);
      if (!token || typeof token !== "object") return null;

      const tokenRow = token as Record<string, unknown>;
      const clientId = readString(tokenRow, "client_id");
      const { data: clientRow, error: clientError } = await client
        .from("clients")
        .select("id, auth_user_id")
        .eq("id", clientId)
        .maybeSingle();
      if (clientError) throw new Error(`payment recovery client lookup failed: ${clientError.message ?? clientError.code ?? "failed"}`);
      if (!clientRow || typeof clientRow !== "object") return null;

      const ownerClient = clientRow as Record<string, unknown>;
      return {
        tokenId: readString(tokenRow, "id"),
        caseId: readString(tokenRow, "case_id"),
        clientId,
        authUserId: readNullableString(ownerClient, "auth_user_id"),
        purpose: readPurpose(tokenRow),
        expiresAt: readString(tokenRow, "expires_at"),
        usedAt: readNullableString(tokenRow, "used_at"),
        revokedAt: readNullableString(tokenRow, "revoked_at"),
      };
    },

    async recordSubscriptionPaymentRecovery(input: SubscriptionPaymentRecoveryInput) {
      const { data, error } = await client.rpc("subscription_record_payment_recovery_request", {
        p_idempotency_key: input.idempotencyKey,
        p_recovery_token: input.recoveryToken,
        p_payment_method_ref: input.paymentMethodRef,
        p_payment_method_kind: input.paymentMethodKind,
        p_requested_at: input.requestedAt,
      });
      if (error) throw mapPaymentRecoveryRpcError(error);
      const parsed = recordSubscriptionPaymentRecoveryResponseSchema.safeParse(data);
      if (!parsed.success) throw new Error("Subscription payment recovery response invalid");
      return parsed.data;
    },

    async resolveRecoveryCaseSubscription({ tokenEvidence }: { tokenEvidence: PaymentRecoveryTokenEvidence }) {
      // Look up the dunning case to find the subscription_id.
      const { data: caseRow, error: caseError } = await client
        .from("subscription_dunning_cases")
        .select("id, subscription_id, status")
        .eq("id", tokenEvidence.caseId)
        .maybeSingle();
      if (caseError) throw new Error(`subscription_dunning_cases lookup failed: ${caseError.message ?? caseError.code ?? "failed"}`);
      if (!caseRow || typeof caseRow !== "object") return null;
      const caseRecord = caseRow as Record<string, unknown>;
      const subscriptionId = readString(caseRecord, "subscription_id");

      // Resolve the Stripe customer ref. The subscription's existing
      // payment-method ref (active or otherwise) is the canonical source —
      // recovery needs to attach the new card to the same Stripe customer
      // so the customer's invoice history stays intact.
      const customerRef = await readSubscriptionCustomerRef(client, subscriptionId, tokenEvidence.clientId);
      return {
        caseId: readString(caseRecord, "id"),
        subscriptionId,
        providerCustomerRef: customerRef,
      };
    },
  };
}

function mapPaymentRecoveryRpcError(error: RpcError): Error {
  const message = error.message ?? error.code ?? "failed";
  if (message.includes("subscription_payment_recovery_idempotency_conflict")) {
    return new PaymentRecoveryRecordError("idempotency_conflict");
  }
  if (message.includes("subscription_payment_recovery_token_invalid")) {
    return new PaymentRecoveryRecordError("token_invalid_or_expired");
  }
  // The expired-dunning resume rail raises through the same RPC. Its raises are
  // customer-actionable outcomes, not server faults: a not-yet-durable method
  // ref is retryable, a case that moved on is terminal. Both must reach the
  // client as a CONFLICT with a reason instead of a generic failure.
  if (message.includes("subscription_resume_after_expired_method_not_chargeable")) {
    return new PaymentRecoveryRecordError("resume_method_not_chargeable");
  }
  if (
    message.includes("subscription_resume_after_expired_invalid_transition") ||
    message.includes("subscription_resume_after_expired_case_not_expired") ||
    message.includes("subscription_payment_recovery_case_state_mismatch") ||
    message.includes("subscription_payment_recovery_case_not_found")
  ) {
    return new PaymentRecoveryRecordError("resume_case_state_changed");
  }
  return new Error(`subscription_record_payment_recovery_request: ${message}`);
}

async function readSubscriptionCustomerRef(
  client: PaymentRecoverySupabaseClient,
  subscriptionId: string,
  clientId: string,
): Promise<string | null> {
  // A subscription (or a client) legitimately has MORE THAN ONE method ref — one
  // active plus any it previously replaced (a card update, or the declined card
  // still bound during dunning). `.maybeSingle()` on a `subscription_id`- or
  // `client_id`-only filter errors ("multiple rows") for those customers, which
  // used to null out the resolution and make the recovery page permanently "not
  // actionable" (CJ01-O). Order the active + most-recent ref first and cap to one
  // row so the lookup is deterministic regardless of how many refs exist. Stripe
  // refs for a client share the same customer, so any one Stripe row is safe.
  // Never pass a Tpay PAYID as a Stripe customer id; BLIK-only resolves to null
  // and the handler uses the existing Stripe ensure-customer boundary.
  const bySub = await client
    .from("commerce_payment_method_refs")
    .select("provider_customer_ref")
    .eq("provider_kind", "stripe")
    .eq("subscription_id", subscriptionId)
    .order("active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!bySub.error && bySub.data && typeof bySub.data === "object") {
    const ref = readNullableString(bySub.data as Record<string, unknown>, "provider_customer_ref");
    if (ref) return ref;
  }
  // Fallback: client-bound method ref from the initial save-card flow.
  const byClient = await client
    .from("commerce_payment_method_refs")
    .select("provider_customer_ref")
    .eq("provider_kind", "stripe")
    .eq("client_id", clientId)
    .order("active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (byClient.error || !byClient.data || typeof byClient.data !== "object") return null;
  return readNullableString(byClient.data as Record<string, unknown>, "provider_customer_ref");
}

function readPurpose(value: Record<string, unknown>): PaymentRecoveryTokenEvidence["purpose"] {
  const purpose = readString(value, "purpose");
  if (purpose === "repair_payment" || purpose === "resume_subscription") return purpose;
  throw new Error("Payment recovery token response invalid");
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) throw new Error("Payment recovery token response invalid");
  return raw;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
