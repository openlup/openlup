import { describe, expect, it } from "vitest";
import {
  createSupabaseCustomerAddressBookPort,
  createSupabaseCustomerPaymentMethodsPort,
} from "./customerProfilePorts.js";

describe("supabase customer profile ports", () => {
  it("exposes customer address and payment-method contracts", () => {
    const client = {} as never;

    expect(createSupabaseCustomerAddressBookPort(client).getAddressBook).toEqual(expect.any(Function));
    expect(createSupabaseCustomerPaymentMethodsPort(client, client).listPaymentMethods).toEqual(expect.any(Function));
  });
});
