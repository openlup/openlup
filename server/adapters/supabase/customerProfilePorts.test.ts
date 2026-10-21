import { describe, expect, it } from "vitest";
import {
  createSupabaseCustomerAddressBookPort,
  createSupabaseCustomerPaymentMethodsPort,
} from "./customerProfilePorts.js";

describe("supabase customer profile ports", () => {
  it("exposes customer address and payment-method contracts and retains missing-audit profile availability", async () => {
    const client = {} as never;

    expect(createSupabaseCustomerAddressBookPort(client).getAddressBook).toEqual(expect.any(Function));
    expect(createSupabaseCustomerPaymentMethodsPort(client, client).listPaymentMethods).toEqual(expect.any(Function));
    const ownerQuery = { select: () => ownerQuery, eq: () => ownerQuery,
      maybeSingle: async () => ({ data: { id: "client-a" }, error: null }) };
    const methodsQuery = { select: () => methodsQuery, eq: () => methodsQuery, order: () => methodsQuery,
      limit: async () => ({ data: [{ id: "method-a", raw_provider_payload: { openlupEvidence: {} } }], error: null }) };
    const methods = await createSupabaseCustomerPaymentMethodsPort(
      { from: () => ownerQuery } as never, { from: () => methodsQuery } as never,
    ).listPaymentMethods("owner-a");
    // Existing profile fallback is retained; recurring execution separately requires consent.
    expect(methods?.[0]?.usableFor, "Missing audit retains existing profile availability").toEqual(["one_time", "subscription"]);
  });
});
