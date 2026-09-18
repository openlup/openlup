import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readSingleSubscriptionPaymentMethodEvidence,
  readSubscriptionPaymentMethodEvidence,
  resolveCustomerSubscriptionPaymentMethodStatus,
} from "./customerSubscriptionPaymentMethodReadModel.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";

describe("customer subscription payment method read model", () => {
  it("reads one canonical payment evidence row per subscription", async () => {
    const evidence = await readSubscriptionPaymentMethodEvidence(
      serviceClient([
        methodRow({ subscription_id: subscriptionId, status: "active", provider_method_ref: "pm_active" }),
        methodRow({ subscription_id: subscriptionId, status: "revoked", provider_method_ref: "pm_old" }),
      ]),
      [subscriptionId, subscriptionId],
    );

    expect(evidence.get(subscriptionId)).toMatchObject({
      clientId,
      providerKind: "stripe",
      providerMethodRef: "pm_active",
      status: "active",
      active: true,
    });
  });

  it("reads a single subscription evidence row for preview telemetry", async () => {
    const evidence = await readSingleSubscriptionPaymentMethodEvidence(
      serviceClient([methodRow({ subscription_id: subscriptionId, status: "pending_verification" })]),
      subscriptionId,
    );

    expect(evidence).toMatchObject({
      providerKind: "stripe",
      status: "pending_verification",
    });
  });

  it("resolves customer-safe status without leaking raw provider refs", () => {
    expect(resolveCustomerSubscriptionPaymentMethodStatus({
      clientId,
      clientEmail: "anna@example.com",
      subscriptionPaymentMethodKind: "card",
      subscriptionPaymentMethodRef: "pm_legacy",
      paymentEvidence: {
        clientId: "33333333-3333-4333-8333-333333333333",
        providerKind: "stripe",
        providerCustomerRef: "cus_1",
        providerMethodRef: "pm_cross",
        methodKind: "card",
        status: "active",
        active: true,
        expiresAt: null,
      },
    })).toBe("invalid");

    expect(resolveCustomerSubscriptionPaymentMethodStatus({
      clientId,
      clientEmail: "anna@example.com",
      subscriptionPaymentMethodKind: "blik_payid",
      subscriptionPaymentMethodRef: null,
      paymentEvidence: {
        clientId,
        providerKind: "tpay",
        providerCustomerRef: null,
        providerMethodRef: "payid_1",
        methodKind: "blik_payid",
        status: "active",
        active: true,
        expiresAt: null,
      },
    })).toBe("usable");
  });
});

function methodRow(patch: Record<string, unknown>) {
  return {
    subscription_id: subscriptionId,
    client_id: clientId,
    provider_kind: "stripe",
    provider_customer_ref: "cus_1",
    provider_method_ref: "pm_1",
    method_kind: "card",
    status: "active",
    active: true,
    expires_at: null,
    ...patch,
  };
}

function serviceClient(rows: Record<string, unknown>[]): SupabaseClient {
  return {
    from() {
      let subscriptionFilter: string | null = null;
      const builder = {
        select: () => builder,
        in: () => builder,
        eq: (column: string, value: string) => {
          if (column === "subscription_id") subscriptionFilter = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: rows.find((row) => row.subscription_id === subscriptionFilter) ?? null,
          error: null,
        }),
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}
