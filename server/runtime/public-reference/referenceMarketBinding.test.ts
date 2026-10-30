import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCurrencyMinor } from "../../../src/lib/currency/formatMinor.js";
import { createReferenceI18n, DEFAULT_REFERENCE_LANGUAGE } from "../../../src/public-reference/subscriptionMessages.js";
import { referenceMarketDescriptor } from "../../adapters/market-packs/referenceMarketDescriptor.js";
import { createReferenceMarketBinding } from "./referenceMarketBinding.js";
import { canonicalAddressKey } from "@openlup/platform/shipping";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("explicit reference market binding", () => {
  it("keeps the current language default, fallback and isolated i18n instances", () => {
    const first = createReferenceI18n();
    const second = createReferenceI18n();
    expect(DEFAULT_REFERENCE_LANGUAGE).toBe("en");
    expect(first.language).toBe(DEFAULT_REFERENCE_LANGUAGE);
    expect(second.language).toBe(DEFAULT_REFERENCE_LANGUAGE);
    const defaultTitle = first.t("account:accountTitle");
    expect(defaultTitle).not.toBe("accountTitle");
    first.changeLanguage("pl");
    expect(second.language).toBe(DEFAULT_REFERENCE_LANGUAGE);
    expect(createReferenceI18n("unsupported").t("account:accountTitle")).toBe(defaultTitle);
  });

  it("defaults to today's separate message and settlement facts without mounting a lookup route", async () => {
    const { routes } = await import("../../../api/bff/[...path].js");
    const selected = createReferenceMarketBinding();
    expect(routes).toEqual([]);
    expect(selected.descriptor).toEqual({ ...referenceMarketDescriptor, language: DEFAULT_REFERENCE_LANGUAGE });
    expect(selected.directory).toBeUndefined();
    expect(selected.companyLookup).toBeDefined();
  });

  it("keeps lookup optional and manual shipping useful without consulting directory or company providers", async () => {
    const provider = vi.fn();
    const lookupPostalCode = vi.fn();
    const directory = { lookupPostalCode, searchLocalities: vi.fn(), listStreets: vi.fn() };
    const selected = createReferenceMarketBinding({ providers: [{ providerKind: "example", lookup: provider }], directory });
    expect(selected.directory).toBe(directory);
    const manual = { kind: "shipping" as const, country: "US", postalCode: "10001", city: "Example City", line1: "Example Road 1" };
    expect(canonicalAddressKey(manual, "example")).toContain("example road 1");
    expect(provider).not.toHaveBeenCalled();
    expect(lookupPostalCode).not.toHaveBeenCalled();
  });

  it("composes language, currency, pricing region and fiscal jurisdiction independently through existing readers", () => {
    const selected = createReferenceMarketBinding({ language: "en", configuration: {
      COMMERCE_SETTLEMENT_CURRENCY: "EUR", COMMERCE_SETTLEMENT_REGION: "CZ",
      COMMERCE_FISCAL_COUNTRY: "DE", COMMERCE_FISCAL_CATEGORY: "standard",
      COMMERCE_FISCAL_VAT_RATE_BPS: "1900", COMMERCE_FISCAL_LEGAL_BASIS: "Example rule",
    } });
    expect(selected.descriptor).toEqual({ language: "en", currency: "EUR", pricingRegion: "CZ", fiscalJurisdiction: "DE" });
    expect(selected.settlement.fiscalProfile).toMatchObject({ country: "DE", category: "standard", vatRateBps: 1900 });
    expect(formatCurrencyMinor(1490, { currency: selected.descriptor.currency, locale: selected.descriptor.language })).toBe("€14.90");
  });

  it("refuses malformed settlement and unsupported language before provider or directory IO", () => {
    const lookup = vi.fn();
    const providers = [{ providerKind: "example", lookup }];
    expect(() => createReferenceMarketBinding({ language: "unsupported" as "en", providers })).toThrow("Unsupported reference language");
    expect(() => createReferenceMarketBinding({ configuration: { COMMERCE_SETTLEMENT_CURRENCY: "bad" }, providers })).toThrow("COMMERCE_SETTLEMENT_CURRENCY");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("initializes the dispatcher before parsing money and keeps repeat/conflict refusal", async () => {
    vi.resetModules();
    const { createReferenceBffDispatcher } = await import("../bffDispatch.js");
    const money = await import("../../../src/lib/currency/platformCurrency.js");
    const configuration = { COMMERCE_SETTLEMENT_CURRENCY: "EUR" };
    const dispatch = createReferenceBffDispatcher(() => configuration);
    const req = { method: "GET", url: "/missing", headers: {}, query: {} };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
    await dispatch([], req as never, res as never);
    expect(money.platformCurrencySchema.safeParse("EUR").success).toBe(true);
    expect(() => money.initAmbientSettlementProfile(money.readSettlementProfile(configuration))).not.toThrow();
    expect(() => money.initAmbientSettlementProfile(money.readSettlementProfile({}))).toThrow(money.ConflictingAmbientSettlementProfileError);
  });
});
