import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveSubscriptionPaymentMethodStatus,
  type SubscriptionPaymentMethodStatus,
} from "../../../src/domains/subscription/contracts.js";

type Row = Record<string, unknown>;

export interface SubscriptionPaymentMethodEvidence {
  clientId: string | null;
  providerKind: string | null;
  providerCustomerRef: string | null;
  providerMethodRef: string | null;
  methodKind: string | null;
  status: string | null;
  active: boolean | null;
  expiresAt: string | null;
}

export async function readSubscriptionPaymentMethodEvidence(
  serviceClient: SupabaseClient,
  subscriptionIds: string[],
): Promise<Map<string, SubscriptionPaymentMethodEvidence>> {
  const ids = Array.from(new Set(subscriptionIds.filter(Boolean)));
  const map = new Map<string, SubscriptionPaymentMethodEvidence>();
  if (ids.length === 0) return map;

  const { data, error } = await serviceClient
    .from("commerce_payment_method_refs")
    .select("subscription_id, client_id, provider_kind, provider_customer_ref, provider_method_ref, method_kind, status, active, expires_at, updated_at, created_at")
    .in("subscription_id", ids)
    .order("active", { ascending: false })
    .order("updated_at", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;

  for (const row of (data ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    if (!subscriptionId || map.has(subscriptionId)) continue;
    map.set(subscriptionId, paymentEvidenceFromRow(row));
  }
  return map;
}

export async function readSingleSubscriptionPaymentMethodEvidence(
  serviceClient: SupabaseClient,
  subscriptionId: string,
): Promise<SubscriptionPaymentMethodEvidence | null> {
  const { data, error } = await serviceClient
    .from("commerce_payment_method_refs")
    .select("client_id, provider_kind, provider_customer_ref, provider_method_ref, method_kind, status, active, expires_at, updated_at, created_at")
    .eq("subscription_id", subscriptionId)
    .order("active", { ascending: false })
    .order("updated_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return isRecord(data) ? paymentEvidenceFromRow(data) : null;
}

export function resolveCustomerSubscriptionPaymentMethodStatus(input: {
  clientId: string | null;
  clientEmail: string | null;
  subscriptionPaymentMethodKind: string | null;
  subscriptionPaymentMethodRef: string | null;
  paymentEvidence: SubscriptionPaymentMethodEvidence | null | undefined;
}): SubscriptionPaymentMethodStatus {
  return resolveSubscriptionPaymentMethodStatus({
    clientId: input.clientId,
    methodClientId: input.paymentEvidence?.clientId ?? null,
    providerKind: input.paymentEvidence?.providerKind ?? null,
    providerCustomerRef: input.paymentEvidence?.providerCustomerRef ?? null,
    providerMethodRef: input.paymentEvidence?.providerMethodRef ?? input.subscriptionPaymentMethodRef,
    methodKind: input.paymentEvidence?.methodKind ?? input.subscriptionPaymentMethodKind,
    methodStatus: input.paymentEvidence?.status ?? null,
    methodActive: input.paymentEvidence?.active ?? null,
    methodExpiresAt: input.paymentEvidence?.expiresAt ?? null,
    payerEmail: input.clientEmail,
  }).status;
}

function paymentEvidenceFromRow(row: Row): SubscriptionPaymentMethodEvidence {
  return {
    clientId: nullableText(row.client_id),
    providerKind: nullableText(row.provider_kind),
    providerCustomerRef: nullableText(row.provider_customer_ref),
    providerMethodRef: nullableText(row.provider_method_ref),
    methodKind: nullableText(row.method_kind),
    status: nullableText(row.status),
    active: booleanOrNull(row.active),
    expiresAt: nullableText(row.expires_at),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
