/** @vitest-environment jsdom */
import { beforeEach, expect, it } from "vitest";
import { canonicalAddressKey } from "@openlup/platform/shipping";
import { formatCurrencyMinor } from "../../lib/currency/formatMinor.js";
import { createConfiguratorDraftPersistedState, getConfiguratorDraftStorageKey, PUBLIC_CONFIGURATOR_DRAFT_SCOPE, serializeConfiguratorIntent } from "./configuratorDraftCodec.js";
import { defaultConfiguratorFormData, type BusinessInvoiceAddress } from "./configuratorFormStore.js";

beforeEach(() => localStorage.clear());

it("reloads permitted shipping identity, excludes invoice identity, and renders historical money in its own currency", () => {
  const data = { ...defaultConfiguratorFormData,
    firstName: "Example", street: "Example Road 1", postalCode: "10001", city: "Example City", country: "US",
    pendingDeliveryOptionId: "delivery-example",
    businessInvoice: { ...defaultConfiguratorFormData.businessInvoice,
      requested: true, taxIdInput: "private-example", lookupStatus: "found" as const,
      acceptedData: { companyName: "Private Example", taxId: "private-example",
        address: { line1: "Invoice Road", city: "Example City", postalCode: "10001", country: defaultConfiguratorFormData.country as BusinessInvoiceAddress["country"] } } },
  };
  const key = getConfiguratorDraftStorageKey(PUBLIC_CONFIGURATOR_DRAFT_SCOPE);
  const store = createConfiguratorDraftPersistedState(key);
  expect(store.save({ form: serializeConfiguratorIntent(data, PUBLIC_CONFIGURATOR_DRAFT_SCOPE), step: 1, maxStep: 1 })).toBe("saved");
  const bytes = localStorage.getItem(key)!;
  expect(bytes).not.toContain("private-example");
  expect(bytes).not.toContain("businessInvoice");
  const restored = createConfiguratorDraftPersistedState(key).load()!;
  expect(restored.form).toMatchObject({ firstName: data.firstName, street: data.street, postalCode: data.postalCode, city: data.city, country: data.country, selectedDeliveryOptionId: data.pendingDeliveryOptionId });
  const address = { kind: "shipping" as const, country: restored.form.country, postalCode: restored.form.postalCode, city: restored.form.city, line1: restored.form.street };
  expect(canonicalAddressKey(address, "example")).toBe(canonicalAddressKey({ ...address }, "example"));
  expect(formatCurrencyMinor(1490, { currency: "JPY", locale: "en-US" })).toBe("¥1,490");
});
