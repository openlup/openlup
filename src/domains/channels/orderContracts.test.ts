import { describe, expect, it } from "vitest";
import {
  CHANNEL_ORDER_CONTRACT_VERSION,
  normalizedChannelOrderSchema,
  unmappedChannelSignalSchema,
} from "./orderContracts.js";

const validOrder = {
  contractVersion: CHANNEL_ORDER_CONTRACT_VERSION,
  channelSlug: "example-marketplace",
  externalOrderRef: "EXT-1001",
  externalOrderRevision: null,
  providerEventId: "evt-ext-1001-v1",
  placedAt: "2026-08-11T10:00:00+02:00",
  currency: "EUR",
  buyer: {
    externalCustomerRef: null,
    email: "relay+abc123@marketplace.example",
    emailIsMasked: true,
    firstName: "Alex",
    lastName: "Doe",
    phone: null,
    taxId: null,
    companyName: null,
  },
  shipTo: {
    recipientName: "Alex Doe",
    line1: "Example Street 1",
    line2: null,
    postalCode: "10001",
    city: "Exampleville",
    countryCode: "DE",
    phone: null,
    pickupPointRef: null,
  },
  lines: [
    {
      externalLineRef: "EXT-1001-L1",
      sellable: { kind: "sku", externalOfferRef: "OFF-1", skuCode: "UNIT-A-400" },
      quantity: 3,
      unitGrossMinor: 1490,
      lineGrossMinor: 4470,
      lineDiscountMinor: 470,
      vatRateBps: 1900,
    },
    {
      externalLineRef: "EXT-1001-L2",
      sellable: { kind: "bundle", externalOfferRef: "OFF-2", bundleCode: "MIX-12" },
      quantity: 1,
      unitGrossMinor: 15880,
      lineGrossMinor: 15880,
      lineDiscountMinor: 0,
      vatRateBps: null,
    },
  ],
  shipping: {
    grossMinor: 1500,
    discountMinor: 0,
    methodLabel: "Courier",
    carrierHint: "carrier-x",
  },
  totals: {
    itemsGrossMinor: 20350,
    itemsDiscountMinor: 470,
    shippingGrossMinor: 1500,
    shippingDiscountMinor: 0,
    grandTotalMinor: 21380,
  },
  payment: {
    state: "paid_externally",
    externalPaymentRef: "PAY-9001",
    paidAt: "2026-08-11T10:05:00+02:00",
    methodLabel: null,
  },
  payloadDigest: "sha256:abc123",
};

describe("normalizedChannelOrderSchema", () => {
  it("accepts a well-formed channel order with sku and bundle lines", () => {
    const parsed = normalizedChannelOrderSchema.safeParse(validOrder);
    expect(parsed.success).toBe(true);
  });

  it("rejects a line whose lineGrossMinor is not unitGrossMinor × quantity", () => {
    const broken = structuredClone(validOrder);
    broken.lines[0].lineGrossMinor = 4471;
    broken.totals.itemsGrossMinor = 20351;
    broken.totals.grandTotalMinor = 21381;
    const parsed = normalizedChannelOrderSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("lineGrossMinor");
  });

  it("rejects totals that do not sum from lines and shipping", () => {
    const broken = structuredClone(validOrder);
    broken.totals.grandTotalMinor = 99999;
    const parsed = normalizedChannelOrderSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("grandTotalMinor");
  });

  it("rejects a discount exceeding the line gross", () => {
    const broken = structuredClone(validOrder);
    broken.lines[0].lineDiscountMinor = 5000;
    broken.totals.itemsDiscountMinor = 5000;
    broken.totals.grandTotalMinor = 20350 - 5000 + 1500;
    const parsed = normalizedChannelOrderSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("lineDiscountMinor");
  });

  it("rejects a blank settlement reference", () => {
    const broken = structuredClone(validOrder);
    broken.payment.externalPaymentRef = "  ";
    const parsed = normalizedChannelOrderSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown sellable kind (contract v1 handles sku and bundle)", () => {
    const broken = structuredClone(validOrder) as Record<string, unknown> & {
      lines: Array<{ sellable: Record<string, unknown> }>;
    };
    broken.lines[0].sellable = { kind: "service", externalOfferRef: null };
    const parsed = normalizedChannelOrderSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });

  it("keeps currency open — any ISO-4217-shaped code parses", () => {
    const foreign = structuredClone(validOrder);
    foreign.currency = "USD";
    const parsed = normalizedChannelOrderSchema.safeParse(foreign);
    expect(parsed.success).toBe(true);
  });
});

describe("unmappedChannelSignalSchema", () => {
  it("requires a non-empty wire vocabulary token", () => {
    expect(
      unmappedChannelSignalSchema.safeParse({
        vocabulary: "ORDER_DISPUTED",
        externalOrderRef: "EXT-1001",
        detail: null,
        payload: { raw: true },
      }).success,
    ).toBe(true);
    expect(
      unmappedChannelSignalSchema.safeParse({
        vocabulary: " ",
        externalOrderRef: null,
        detail: null,
        payload: {},
      }).success,
    ).toBe(false);
  });
});
