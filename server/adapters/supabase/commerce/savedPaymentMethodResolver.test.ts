import { describe, expect, it } from "vitest";

import { createSupabaseSavedPaymentMethodResolver } from "./savedPaymentMethodResolver.js";

const USER_ID = "user_123";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const METHOD_ID = "22222222-2222-4222-8222-222222222222";

describe("Supabase saved payment method resolver", () => {
  it("resolves an active owner-bound Tpay BLIK PAYID ref", async () => {
    const resolver = createSupabaseSavedPaymentMethodResolver(fakeClient({
      clientRow: { id: CLIENT_ID },
      methodRow: {
        id: METHOD_ID,
        provider_method_ref: "payid_secret",
        expires_at: null,
      },
    }));

    await expect(resolver.resolveSavedPaymentMethod({
      accessToken: "token",
      clientId: CLIENT_ID,
      savedMethodId: METHOD_ID,
      requestedFlow: "blik_one_click",
      now: new Date("2026-06-24T12:00:00Z"),
    })).resolves.toEqual({ providerMethodRef: "payid_secret", providerAliasType: "PAYID" });
  });

  it("resolves UID aliases for one-click but not subscription saved charges", async () => {
    const resolver = createSupabaseSavedPaymentMethodResolver(fakeClient({
      clientRow: { id: CLIENT_ID },
      methodRow: {
        id: METHOD_ID,
        provider_method_ref: "uid_secret",
        expires_at: null,
        raw_provider_payload: { aliasType: "UID" },
      },
    }));

    await expect(resolver.resolveSavedPaymentMethod({
      accessToken: "token",
      clientId: CLIENT_ID,
      savedMethodId: METHOD_ID,
      requestedFlow: "blik_one_click",
      now: new Date("2026-06-24T12:00:00Z"),
    })).resolves.toEqual({ providerMethodRef: "uid_secret", providerAliasType: "UID" });

    await expect(resolver.resolveSavedPaymentMethod({
      accessToken: "token",
      clientId: CLIENT_ID,
      savedMethodId: METHOD_ID,
      requestedFlow: "blik_recurring_saved",
      now: new Date("2026-06-24T12:00:00Z"),
    })).resolves.toBeNull();
  });

  it("resolves subscription reuse only for an explicitly stored Model O PAYID", async () => {
    const modelO = createSupabaseSavedPaymentMethodResolver(fakeClient({
      clientRow: { id: CLIENT_ID },
      methodRow: {
        id: METHOD_ID,
        provider_method_ref: "payid_model_o",
        expires_at: null,
        consent_snapshot: { recurringModel: "O" },
      },
    }));
    const modelM = createSupabaseSavedPaymentMethodResolver(fakeClient({
      clientRow: { id: CLIENT_ID },
      methodRow: {
        id: METHOD_ID,
        provider_method_ref: "payid_model_m",
        expires_at: null,
        consent_snapshot: { recurringModel: "M" },
      },
    }));
    const input = {
      accessToken: "token",
      clientId: CLIENT_ID,
      savedMethodId: METHOD_ID,
      requestedFlow: "blik_recurring_saved" as const,
      now: new Date("2026-06-24T12:00:00Z"),
    };

    await expect(modelO.resolveSavedPaymentMethod(input)).resolves.toEqual({
      providerMethodRef: "payid_model_o",
      providerAliasType: "PAYID",
      recurringModel: "O",
    });
    await expect(modelM.resolveSavedPaymentMethod(input)).resolves.toBeNull();
  });

  it("fails closed when the auth user does not own the checkout client", async () => {
    const resolver = createSupabaseSavedPaymentMethodResolver(fakeClient({
      clientRow: null,
      methodRow: {
        id: METHOD_ID,
        provider_method_ref: "payid_secret",
        expires_at: null,
      },
    }));

    await expect(resolver.resolveSavedPaymentMethod({
      accessToken: "token",
      clientId: CLIENT_ID,
      savedMethodId: METHOD_ID,
      requestedFlow: "blik_one_click",
      now: new Date("2026-06-24T12:00:00Z"),
    })).resolves.toBeNull();
  });

  it("fails closed for expired saved methods", async () => {
    const resolver = createSupabaseSavedPaymentMethodResolver(fakeClient({
      clientRow: { id: CLIENT_ID },
      methodRow: {
        id: METHOD_ID,
        provider_method_ref: "payid_secret",
        expires_at: "2026-06-24T11:59:59Z",
      },
    }));

    await expect(resolver.resolveSavedPaymentMethod({
      accessToken: "token",
      clientId: CLIENT_ID,
      savedMethodId: METHOD_ID,
      requestedFlow: "blik_recurring_saved",
      now: new Date("2026-06-24T12:00:00Z"),
    })).resolves.toBeNull();
  });
});

function fakeClient({
  clientRow,
  methodRow,
}: {
  clientRow: Record<string, unknown> | null;
  methodRow: Record<string, unknown> | null;
}) {
  return {
    auth: {
      async getUser() {
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
    from(table: string) {
      return makeBuilder(table === "clients" ? clientRow : methodRow);
    },
  };
}

function makeBuilder(row: Record<string, unknown> | null) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle() {
      return { data: row, error: null };
    },
  };
}
