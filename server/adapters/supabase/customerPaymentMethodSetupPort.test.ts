import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseCustomerPaymentMethodSetupPort } from "./customerPaymentMethodSetupPort.js";

const SUB = "5b000000-0000-0000-0000-000000000001";
const CLIENT = "c0000000-0000-0000-0000-000000000001";

type Result = { data: unknown; error: unknown };

// Minimal chainable Supabase stub: every filter/order returns `this`, and the terminal
// `maybeSingle()` resolves the per-table result (functions may return per-call values).
function mockClient(tables: Record<string, Result | (() => Result)>): SupabaseClient {
  const build = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) chain[method] = () => chain;
    chain.maybeSingle = async () => {
      const entry = tables[table];
      return typeof entry === "function" ? entry() : (entry ?? { data: null, error: null });
    };
    return chain;
  };
  return { from: (table: string) => build(table) } as unknown as SupabaseClient;
}

const port = (client: SupabaseClient) => createSupabaseCustomerPaymentMethodSetupPort(client);

describe("resolveSubscriptionForCardSetup", () => {
  it("resolves the owner client + existing Stripe customer for an owned subscription", async () => {
    const client = mockClient({
      clients: { data: { id: CLIENT }, error: null },
      subscriptions: { data: { id: SUB, client_id: CLIENT }, error: null },
      commerce_payment_method_refs: { data: { provider_customer_ref: "cus_existing" }, error: null },
    });
    const result = await port(client).resolveSubscriptionForCardSetup({ userId: "user-1", subscriptionId: SUB });
    expect(result).toEqual({ clientId: CLIENT, subscriptionId: SUB, providerCustomerRef: "cus_existing" });
  });

  it("returns providerCustomerRef=null when the subscription has no Stripe method yet", async () => {
    const client = mockClient({
      clients: { data: { id: CLIENT }, error: null },
      subscriptions: { data: { id: SUB, client_id: CLIENT }, error: null },
      commerce_payment_method_refs: { data: { provider_customer_ref: null }, error: null },
    });
    const result = await port(client).resolveSubscriptionForCardSetup({ userId: "user-1", subscriptionId: SUB });
    expect(result).toEqual({ clientId: CLIENT, subscriptionId: SUB, providerCustomerRef: null });
  });

  it("returns null (forbidden) when the subscription belongs to another client", async () => {
    const client = mockClient({
      clients: { data: { id: CLIENT }, error: null },
      subscriptions: { data: { id: SUB, client_id: "someone-else" }, error: null },
    });
    const result = await port(client).resolveSubscriptionForCardSetup({ userId: "user-1", subscriptionId: SUB });
    expect(result).toBeNull();
  });

  it("returns null when the auth user maps to no client", async () => {
    const client = mockClient({ clients: { data: null, error: null } });
    const result = await port(client).resolveSubscriptionForCardSetup({ userId: "ghost", subscriptionId: SUB });
    expect(result).toBeNull();
  });
});
