import { describe, expect, it } from "vitest";
import { sumCanonicalInvoicePositions } from "./invoicePositionSnapshot.js";

describe("canonical invoice position snapshot", () => {
  it("validates and sums canonical item allocations and discounted delivery", () => {
    expect(sumCanonicalInvoicePositions(canonicalPositions())).toEqual({
      valid: true,
      grossCents: 3001,
      netCents: 2779,
      itemGrossCents: 2001,
      itemNetCents: 1853,
      itemCatalogGrossCents: 2002,
      itemDiscountAllocatedCents: 1,
      deliveryGrossCents: 1000,
      deliveryNetCents: 926,
      shippingGrossCents: 1500,
      shippingDiscountCents: 500,
      items: [
        {
          orderItemId: "item-1",
          allocationOrdinal: 1,
          quantity: 1,
          unitGrossCents: 1000,
          unitNetCents: 926,
          totalGrossCents: 1000,
          totalNetCents: 926,
          catalogGrossCents: 1001,
          discountAllocatedCents: 1,
          vatRateBps: 800,
        },
        {
          orderItemId: "item-2",
          allocationOrdinal: 2,
          quantity: 1,
          unitGrossCents: 1001,
          unitNetCents: 927,
          totalGrossCents: 1001,
          totalNetCents: 927,
          catalogGrossCents: 1001,
          discountAllocatedCents: 0,
          vatRateBps: 800,
        },
      ],
    });
  });

  it("parses the SQL decimal VAT label exactly in basis points", () => {
    const item = canonicalItem({
      totalGrossMinor: 10_007,
      unitGrossMinor: 10_007,
      totalNetMinor: 10_000,
      unitNetMinor: 10_000,
      vatRate: "0.07",
      vatRateBps: 7,
      catalogTotalGrossMinor: 10_007,
    });

    expect(sumCanonicalInvoicePositions([item])).toMatchObject({
      valid: true,
      grossCents: 10_007,
      netCents: 10_000,
    });
  });

  it("accepts mixed item VAT rates only when there is no effective delivery", () => {
    const rows = [
      canonicalItem({
        orderItemId: "item-1", allocationOrdinal: 1, totalGrossMinor: 1080,
        unitGrossMinor: 1080, totalNetMinor: 1000, unitNetMinor: 1000,
        catalogTotalGrossMinor: 1080,
      }),
      canonicalItem({
        orderItemId: "item-2", allocationOrdinal: 2, totalGrossMinor: 1230,
        unitGrossMinor: 1230, totalNetMinor: 1000, unitNetMinor: 1000,
        vatRate: "23", vatRateBps: 2300, catalogTotalGrossMinor: 1230,
      }),
    ];

    expect(sumCanonicalInvoicePositions(rows)).toMatchObject({ valid: true, grossCents: 2310, netCents: 2000 });
  });

  it.each([
    ["missing VAT bps", (rows: CanonicalRow[]) => { delete rows[0].vatRateBps; }],
    ["negative VAT", (rows: CanonicalRow[]) => { rows[0].vatRate = "-1"; rows[0].vatRateBps = -100; }],
    ["VAT above 100%", (rows: CanonicalRow[]) => { rows[0].vatRate = "200"; rows[0].vatRateBps = 20_000; }],
    ["VAT representations disagree", (rows: CanonicalRow[]) => { rows[0].vatRateBps = 500; }],
    ["wrong effective net", (rows: CanonicalRow[]) => { rows[0].totalNetMinor = 925; rows[0].unitNetMinor = 925; }],
    ["missing unit gross", (rows: CanonicalRow[]) => { delete rows[0].unitGrossMinor; }],
    ["wrong rounded unit gross", (rows: CanonicalRow[]) => { rows[0].unitGrossMinor = 999; }],
    ["missing allocation ordinal", (rows: CanonicalRow[]) => { delete rows[0].allocationOrdinal; }],
    ["duplicate allocation ordinal", (rows: CanonicalRow[]) => { rows[1].allocationOrdinal = 1; }],
    ["descending allocation ordinal", (rows: CanonicalRow[]) => {
      rows[0].allocationOrdinal = 3; rows[1].allocationOrdinal = 2;
    }],
    ["missing item id", (rows: CanonicalRow[]) => { delete rows[0].orderItemId; }],
    ["duplicate item id", (rows: CanonicalRow[]) => { rows[1].orderItemId = rows[0].orderItemId; }],
    ["catalog allocation equation", (rows: CanonicalRow[]) => { rows[0].catalogTotalGrossMinor = 1002; }],
    ["allocator tie break", (rows: CanonicalRow[]) => {
      rows[0].totalGrossMinor = 1001; rows[0].unitGrossMinor = 1001;
      rows[0].totalNetMinor = 927; rows[0].unitNetMinor = 927; rows[0].discountAllocatedMinor = 0;
      rows[1].totalGrossMinor = 1000; rows[1].unitGrossMinor = 1000;
      rows[1].totalNetMinor = 926; rows[1].unitNetMinor = 926; rows[1].discountAllocatedMinor = 1;
    }],
    ["delivery quantity", (rows: CanonicalRow[]) => { rows[2].quantity = 2; }],
    ["delivery unit gross", (rows: CanonicalRow[]) => { rows[2].unitGrossMinor = 999; }],
    ["delivery shipping residual", (rows: CanonicalRow[]) => { rows[2].shippingDiscountMinor = 499; }],
    ["delivery VAT differs from goods", (rows: CanonicalRow[]) => {
      rows[2].vatRate = "23"; rows[2].vatRateBps = 2300;
      rows[2].totalNetMinor = 813; rows[2].unitNetMinor = 813;
    }],
    ["delivery before an item", (rows: CanonicalRow[]) => { rows.splice(0, 3, rows[0], rows[2], rows[1]); }],
    ["delivery carries ordinal", (rows: CanonicalRow[]) => { rows[2].allocationOrdinal = null; }],
    ["legacy row without position kind", (rows: CanonicalRow[]) => { delete rows[0].positionKind; }],
  ])("rejects %s", (_label, mutate) => {
    const rows = canonicalPositions();
    mutate(rows);
    expect(sumCanonicalInvoicePositions(rows)).toEqual({ valid: false, grossCents: null, netCents: null });
  });

  it("rejects a delivery-only snapshot without a canonical order item", () => {
    expect(sumCanonicalInvoicePositions([canonicalDelivery()]))
      .toEqual({ valid: false, grossCents: null, netCents: null });
  });

  it("accepts positive ordered allocation ordinals with legacy gaps", () => {
    const rows = canonicalPositions();
    rows[0].allocationOrdinal = 2;
    rows[1].allocationOrdinal = 4;

    expect(sumCanonicalInvoicePositions(rows)).toMatchObject({ valid: true, grossCents: 3001 });
  });

  it("computes VAT net and unit rounding exactly at the safe-integer boundary", () => {
    const gross = Number.MAX_SAFE_INTEGER;
    const denominator = 10_800n;
    const net = Number((BigInt(gross) * 10_000n + denominator / 2n) / denominator);

    expect(sumCanonicalInvoicePositions([canonicalItem({
      orderItemId: "item-max-safe",
      totalGrossMinor: gross,
      unitGrossMinor: gross,
      totalNetMinor: net,
      unitNetMinor: net,
      catalogTotalGrossMinor: gross,
    })])).toMatchObject({ valid: true, grossCents: gross, netCents: net });
  });
});

type CanonicalRow = Record<string, unknown>;

function canonicalPositions(): CanonicalRow[] {
  return [
    canonicalItem({
      orderItemId: "item-1",
      allocationOrdinal: 1,
      totalGrossMinor: 1000,
      unitGrossMinor: 1000,
      totalNetMinor: 926,
      unitNetMinor: 926,
      discountAllocatedMinor: 1,
    }),
    canonicalItem({ orderItemId: "item-2", allocationOrdinal: 2 }),
    canonicalDelivery(),
  ];
}

function canonicalItem(overrides: CanonicalRow = {}): CanonicalRow {
  return {
    positionKind: "item",
    orderItemId: "item-1",
    allocationOrdinal: 1,
    name: "Karma",
    quantity: 1,
    unitGrossMinor: 1001,
    totalGrossMinor: 1001,
    unitNetMinor: 927,
    totalNetMinor: 927,
    vatRate: "8",
    vatRateBps: 800,
    discountAllocatedMinor: 0,
    catalogTotalGrossMinor: 1001,
    ...overrides,
  };
}

function canonicalDelivery(): CanonicalRow {
  return {
    positionKind: "delivery",
    orderItemId: null,
    name: "Dostawa",
    quantity: 1,
    unitGrossMinor: 1000,
    totalGrossMinor: 1000,
    unitNetMinor: 926,
    totalNetMinor: 926,
    vatRate: "8",
    vatRateBps: 800,
    shippingGrossMinor: 1500,
    shippingDiscountMinor: 500,
  };
}
