import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerPaymentMethodSetupPort } from "../../domains/customers/ports.js";

/**
 * Resolves the Stripe SetupIntent target for an account "update card" request (CJ63-A):
 * the authenticated user's client, the subscription they own, and its existing Stripe
 * customer ref (null → the handler mints a fresh Stripe customer). Ownership is enforced
 * here — a user can only set up a card for a subscription bound to their own client — so
 * the flow is not an IDOR vector even though it runs on the service client.
 */
export function createSupabaseCustomerPaymentMethodSetupPort(
  client: SupabaseClient,
): CustomerPaymentMethodSetupPort {
  return {
    async resolveSubscriptionForCardSetup({ userId, subscriptionId }) {
      const clientId = await readClientId(client, userId);
      if (!clientId) return null;

      // Ownership gate: the subscription must belong to the caller's client.
      const { data: subRow, error: subError } = await client
        .from("subscriptions")
        .select("id, client_id")
        .eq("id", subscriptionId)
        .maybeSingle();
      if (subError) throw new Error(`subscriptions lookup failed: ${subError.message ?? subError.code ?? "failed"}`);
      if (!subRow || typeof subRow !== "object") return null;
      const ownerClientId = readNullableString(subRow as Record<string, unknown>, "client_id");
      if (ownerClientId !== clientId) return null;

      const providerCustomerRef = await readSubscriptionCustomerRef(client, subscriptionId, clientId);
      return { clientId, subscriptionId, providerCustomerRef };
    },
  };
}

async function readClientId(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client
    .from("clients")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error || !data || typeof data !== "object") return null;
  return readNullableString(data as Record<string, unknown>, "id");
}

async function readSubscriptionCustomerRef(
  client: SupabaseClient,
  subscriptionId: string,
  clientId: string,
): Promise<string | null> {
  // A subscription/client legitimately has multiple method refs (active + replaced); all
  // share one Stripe customer, so order active+recent first and take a single row. Mirrors
  // the recovery port's resolution (CJ01-O). Absent → the handler creates a Stripe customer.
  const bySub = await client
    .from("commerce_payment_method_refs")
    .select("provider_customer_ref")
    .eq("subscription_id", subscriptionId)
    .order("active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!bySub.error && bySub.data && typeof bySub.data === "object") {
    const ref = readNullableString(bySub.data as Record<string, unknown>, "provider_customer_ref");
    if (ref) return ref;
  }
  const byClient = await client
    .from("commerce_payment_method_refs")
    .select("provider_customer_ref")
    .eq("client_id", clientId)
    .order("active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (byClient.error || !byClient.data || typeof byClient.data !== "object") return null;
  return readNullableString(byClient.data as Record<string, unknown>, "provider_customer_ref");
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
