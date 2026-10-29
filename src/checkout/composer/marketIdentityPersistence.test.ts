/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalAddressKey } from "@openlup/platform/shipping";
import { createConfiguratorDraftPersistedState, getConfiguratorDraftStorageKey, PUBLIC_CONFIGURATOR_DRAFT_SCOPE, serializeConfiguratorIntent } from "./configuratorDraftCodec";
import { defaultConfiguratorFormData, type BusinessInvoiceAddress } from "./configuratorFormStore";

beforeEach(() => localStorage.clear());
describe("market identity draft fit", () => {
  it("reloads permitted shipping intent without final invoice identity", () => {
    const data = { ...defaultConfiguratorFormData, firstName: "Example", street: "Example Road 1", postalCode: "10001", city: "Example City", country: "US", pendingDeliveryOptionId: "delivery-fixture", businessInvoice: { requested: true, taxIdInput: "fixture-private-tax", lookupStatus: "found" as const, lookupError: null, lookupResult: null, acceptedData: { companyName: "Fixture Private Company", taxId: "fixture-private-tax", address: { line1: "Invoice Road", city: "Invoice City", postalCode: "10001", country: defaultConfiguratorFormData.country as BusinessInvoiceAddress["country"] } } } };
    const form = serializeConfiguratorIntent(data, PUBLIC_CONFIGURATOR_DRAFT_SCOPE);
    const key = getConfiguratorDraftStorageKey(PUBLIC_CONFIGURATOR_DRAFT_SCOPE);
    expect(createConfiguratorDraftPersistedState(key).save({ form, step: 1, maxStep: 1 })).toBe("saved");
    const bytes = localStorage.getItem(key)!;
    expect(bytes).not.toContain("Fixture Private Company"); expect(bytes).not.toContain("fixture-private-tax");
    expect(bytes).not.toContain("businessInvoice");
    const loaded = createConfiguratorDraftPersistedState(key).load()!;
    expect(loaded.form).toMatchObject({ country: "US", street: "Example Road 1", postalCode: "10001", city: "Example City", selectedDeliveryOptionId: "delivery-fixture" });
    const address = { country: loaded.form.country, postalCode: loaded.form.postalCode, city: loaded.form.city, line1: loaded.form.street, kind: "shipping" as const };
    expect(canonicalAddressKey(address, "host-default")).toBe(canonicalAddressKey({ ...address, country: "US", line1: "Example Road 1" }, "host-default"));
    expect(canonicalAddressKey(address, "host-default")).toContain("us|10001|example city|example road 1");
  });
});
