import { describe, expect, it, vi } from "vitest";
import { formatCurrencyMinor } from "@openlup/platform/market-packs";
import { createReferenceMarketRecipe } from "./marketRecipe.js";
import { referenceMarketDescriptor, referenceSettlementFallbacks } from "./referenceMarketDescriptor.js";
import { referenceAddressCanonSchemas, normalizeDirectoryText } from "./referenceAddressCanon.js";
import * as address from "../../../src/domains/address-canon/contracts.js";
import { readSettlementProfile as currentSettlement } from "../../../src/lib/currency/settlementProfile.js";

const configuration = { COMMERCE_SETTLEMENT_CURRENCY: "EUR", COMMERCE_SETTLEMENT_REGION: "CZ", COMMERCE_FISCAL_COUNTRY: "DE", COMMERCE_FISCAL_CATEGORY: "standard", COMMERCE_FISCAL_VAT_RATE_BPS: "1900", COMMERCE_FISCAL_LEGAL_BASIS: "Example rule" };
const recipe = (delta = {}) => createReferenceMarketRecipe({ language: "en", configuration, providers: [], ...delta });

describe("unmounted reference recipe", () => {
  it("composes English, configured money, price region and fiscal jurisdiction independently", () => {
    const value = recipe();
    expect(value.descriptor).toEqual({ language: "en", currency: "EUR", pricingRegion: "CZ", fiscalJurisdiction: "DE" });
    expect(value.settlement).toEqual(currentSettlement(configuration));
    expect(formatCurrencyMinor(1490, { currency: value.descriptor.currency, locale: value.descriptor.language })).toBe("€14.90");
    for (const [key, configured, field] of [
      ["COMMERCE_SETTLEMENT_CURRENCY", "GBP", "currency"],
      ["COMMERCE_SETTLEMENT_REGION", "XY", "pricingRegion"],
      ["COMMERCE_FISCAL_COUNTRY", "ZW", "fiscalJurisdiction"],
    ]) expect(recipe({ configuration: { ...configuration, [key]: configured } }).descriptor).toEqual({ ...value.descriptor, [field]: configured });
    expect(recipe({ language: "pl" }).descriptor).toEqual({ ...value.descriptor, language: "pl" });
  });
  it("imports compatibility facts without changing current defaults", () => {
    expect(recipe({ configuration: {}, language: referenceMarketDescriptor.language as "pl" }).descriptor).toEqual(referenceMarketDescriptor);
    expect(recipe({ configuration: {} }).settlement).toEqual(currentSettlement({}));
    expect(referenceSettlementFallbacks.fiscalProfile).toEqual(currentSettlement({}).fiscalProfile);
  });
  it("refuses unknown selection and malformed configuration without provider IO", () => {
    const lookup = vi.fn();
    const providers = [{ providerKind: "example", lookup }];
    expect(() => recipe({ language: "unknown", providers })).toThrow("Unsupported reference language");
    expect(() => recipe({ configuration: { COMMERCE_SETTLEMENT_CURRENCY: "bad" }, providers })).toThrow("COMMERCE_SETTLEMENT_CURRENCY");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("keeps unsupported lookup and explicit manual identity separate, without IO", async () => {
    const lookup = vi.fn();
    const selected = recipe({ providers: [{ providerKind: "example", lookup }] });
    const input = { country: "ZZ", identifierKind: "national", identifierValue: "synthetic", purpose: "checkout_invoice" as const };
    expect(await selected.companyLookup.lookupCompanyIdentity(input)).toMatchObject({ status: "unsupported_country", verificationLevel: "invalid", company: null, sources: [], warnings: ["unsupported_country"] });
    expect(await selected.companyLookup.lookupCompanyIdentity({ ...input, identifierKind: "custom", manualCompany: { legalName: "Manual Example", registeredAddress: null } })).toMatchObject({ status: "partial", verificationLevel: "manual_unverified", company: { legalName: "Manual Example", regon: null, vatStatus: null }, sources: [], warnings: ["manual_unverified"] });
    expect(lookup).not.toHaveBeenCalled();
    expect(selected.directory).toBeUndefined();
  });
  it("passes through an optional directory without probing or turning suggestions into admission", () => {
    const directory = { lookupPostalCode: vi.fn(), searchLocalities: vi.fn(), listStreets: vi.fn() };
    expect(recipe({ directory }).directory).toBe(directory);
    expect(directory.lookupPostalCode).not.toHaveBeenCalled();
    expect(directory.searchLocalities).not.toHaveBeenCalled();
  });
  it("reuses existing shipping schema objects and the distinct managed normalizer", () => {
    for (const [key, schema] of Object.entries(referenceAddressCanonSchemas)) expect(schema).toBe(address[key as keyof typeof address]);
    expect(normalizeDirectoryText("  Łódź, ROAD  ")).toBe("odz road");
    const input = { postalCode: "10001" };
    expect(referenceAddressCanonSchemas.addressCanonPostalCodeLookupRequestSchema.safeParse(input)).toEqual(address.addressCanonPostalCodeLookupRequestSchema.safeParse(input));
  });
});
