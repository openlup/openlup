import { describe, expect, it } from "vitest";
import {
  getVendorAdapterRegistration,
  readCustomerAuthProviderKind,
  UnknownVendorAdapterError,
  VENDOR_ADAPTER_REGISTRY,
} from "./vendorRegistry.js";

describe("vendor adapter registry", () => {
  it("registers selected vendors as hidden, disabled live-call shells", () => {
    expect(VENDOR_ADAPTER_REGISTRY.map((entry) => entry.providerKind).sort()).toEqual([
      "fakturownia",
      "omnipack",
      "stripe",
      "supabase",
      "tpay",
    ]);
    expect(VENDOR_ADAPTER_REGISTRY.every((entry) => entry.liveCallsEnabled === false)).toBe(true);
  });

  it("routes selected providers and fails closed for unknown providers", () => {
    expect(getVendorAdapterRegistration("stripe")).toMatchObject({
      folder: "api/infra/stripe",
      role: "payment",
      activationFlag: "COMMERCE_PAYMENT_PROVIDER_EXECUTION_ENABLED",
    });
    expect(getVendorAdapterRegistration("omnipack")).toMatchObject({
      folder: "api/infra/omnipack",
      role: "fulfillment",
      activationFlag: "COMMERCE_OMNIPACK_DISPATCH_ENABLED",
    });
    expect(getVendorAdapterRegistration("supabase")).toMatchObject({
      folder: "server/adapters/supabase",
      role: "auth",
      activationFlag: "COMMERCE_V2_W12_CUSTOMER_AUTH_UI",
    });
    expect(() => getVendorAdapterRegistration("payu")).toThrow(UnknownVendorAdapterError);
  });
});

describe("readCustomerAuthProviderKind", () => {
  it("defaults to supabase when unset", () => {
    expect(readCustomerAuthProviderKind({})).toBe("supabase");
  });

  it("honors an explicit supabase selection", () => {
    expect(readCustomerAuthProviderKind({ COMMERCE_AUTH_PROVIDER_KIND: " Supabase " })).toBe(
      "supabase",
    );
  });

  it("falls back to supabase for an unknown kind", () => {
    expect(readCustomerAuthProviderKind({ COMMERCE_AUTH_PROVIDER_KIND: "auth0" })).toBe("supabase");
  });
});
