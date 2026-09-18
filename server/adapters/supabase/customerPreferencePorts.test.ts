import { describe, expect, it } from "vitest";
import {
  createSupabaseCustomerDeliveryPreferencesPort,
  createSupabaseCustomerPaymentPreferencesPort,
} from "./customerPreferencePorts.js";

describe("supabase customer preference ports", () => {
  it("exposes payment and delivery preference contracts", () => {
    const client = {} as never;

    expect(createSupabaseCustomerPaymentPreferencesPort(client).listPaymentPreferences).toEqual(expect.any(Function));
    expect(createSupabaseCustomerPaymentPreferencesPort(client).upsertPaymentPreference).toEqual(expect.any(Function));
    expect(createSupabaseCustomerDeliveryPreferencesPort(client).listDeliveryPreferences).toEqual(expect.any(Function));
    expect(createSupabaseCustomerDeliveryPreferencesPort(client).upsertDeliveryPreference).toEqual(expect.any(Function));
  });
});
