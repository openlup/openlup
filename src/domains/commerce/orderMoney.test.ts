import { describe, expect, it, vi } from "vitest";
import {
  deriveOrderMoney,
  ORDER_HEADER_MONEY_COLUMNS,
  ORDER_ITEM_MONEY_COLUMNS,
  type OrderMoneyHeaderRow,
  type OrderMoneyItemRow,
} from "./orderMoney.js";

const order: OrderMoneyHeaderRow = {
  id: "order-1",
  currency: "PLN",
  subtotal_cents: 8_940,
  discount_cents: 745,
  shipping_cents: 1_200,
  shipping_discount_cents: 1_200,
  tax_cents: 607,
  total_cents: 8_195,
};

const items: OrderMoneyItemRow[] = [
  {
    id: "line-1",
    quantity: 3,
    unit_price_cents: 745,
    total_cents: 2_235,
    discount_allocated_cents: 186,
    effective_total_cents: 2_049,
    effective_net_cents: 1_897,
    vat_rate_bps: 800,
  },
  {
    id: "line-2",
    quantity: 1,
    unit_price_cents: 6_705,
    total_cents: 6_705,
    discount_allocated_cents: 559,
    effective_total_cents: 6_146,
    effective_net_cents: 5_691,
    vat_rate_bps: 800,
  },
];

describe("deriveOrderMoney", () => {
  it("trusts the frozen item allocation and validates free delivery", () => {
    expect(deriveOrderMoney(order, items)).toEqual({
      orderId: "order-1",
      currency: "PLN",
      subtotal: 8_940,
      productDiscount: 745,
      shippingGross: 1_200,
      shippingDiscount: 1_200,
      shippingEffective: 0,
      tax: 607,
      total: 8_195,
      lines: [
        {
          id: "line-1",
          quantity: 3,
          catalogUnit: 745,
          catalogTotal: 2_235,
          discountAllocated: 186,
          effectiveGross: 2_049,
          effectiveNet: 1_897,
          vatRateBps: 800,
        },
        {
          id: "line-2",
          quantity: 1,
          catalogUnit: 6_705,
          catalogTotal: 6_705,
          discountAllocated: 559,
          effectiveGross: 6_146,
          effectiveNet: 5_691,
          vatRateBps: 800,
        },
      ],
      validationScope: "full",
      reconciled: true,
      issueCodes: [],
    });
  });

  it("uses header-only validation when lines were not selected", () => {
    const result = deriveOrderMoney(order);
    expect(result.validationScope).toBe("header");
    expect(result.reconciled).toBe(true);
    expect(result.lines).toEqual([]);
  });

  it("falls back to catalog values and emits one diagnostic for a NULL trio", () => {
    const diagnostic = vi.fn();
    const result = deriveOrderMoney(order, [{
      ...items[0]!,
      total_cents: 8_940,
      discount_allocated_cents: null,
      effective_total_cents: null,
      effective_net_cents: null,
    }], diagnostic);

    expect(result.lines[0]).toMatchObject({
      catalogTotal: 8_940,
      discountAllocated: 0,
      effectiveGross: 8_940,
      effectiveNet: 8_278,
    });
    expect(result.reconciled).toBe(false);
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "missing_item_canonical_money",
      "allocated_discount_mismatch",
      "effective_subtotal_mismatch",
      "total_positions_mismatch",
      "tax_total_mismatch",
    ]));
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: "commerce_order_money_unreconciled",
      orderId: "order-1",
      validationScope: "full",
    }));
  });

  it("treats a partial trio as unreconciled and never mixes persisted with fallback values", () => {
    const result = deriveOrderMoney(order, [{
      ...items[0]!,
      total_cents: 8_940,
      discount_allocated_cents: 745,
      effective_total_cents: null,
      effective_net_cents: 7_588,
    }], vi.fn());

    expect(result.reconciled).toBe(false);
    expect(result.issueCodes).toContain("missing_item_canonical_money");
    expect(result.lines[0]).toMatchObject({
      catalogTotal: 8_940,
      discountAllocated: 0,
      effectiveGross: 8_940,
      effectiveNet: 8_278,
    });
  });

  it("reports persisted header, gross, net, and allocation mismatches without reallocating", () => {
    const result = deriveOrderMoney(
      { ...order, shipping_discount_cents: 1_300, total_cents: 8_200 },
      [{ ...items[0]!, effective_total_cents: 2_050, effective_net_cents: 1_896 }, items[1]!],
    );

    expect(result.reconciled).toBe(false);
    expect(result.lines[0]).toMatchObject({
      discountAllocated: 186,
      effectiveGross: 2_050,
      effectiveNet: 1_896,
    });
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "shipping_discount_out_of_range",
      "header_equation_mismatch",
      "item_gross_equation_mismatch",
      "item_net_vat_mismatch",
      "effective_subtotal_mismatch",
      "total_positions_mismatch",
      "tax_total_mismatch",
    ]));
  });

  it("validates the frozen catalog unit-by-quantity equation", () => {
    const result = deriveOrderMoney(order, [
      { ...items[0]!, unit_price_cents: 744 },
      items[1]!,
    ], vi.fn());

    expect(result.reconciled).toBe(false);
    expect(result.issueCodes).toContain("item_catalog_equation_mismatch");
  });

  it("rejects negative allocations even when aggregate equations balance", () => {
    const result = deriveOrderMoney({
      id: "order-balanced-negative-allocation",
      currency: "PLN",
      subtotal_cents: 200,
      discount_cents: 20,
      shipping_cents: 0,
      shipping_discount_cents: 0,
      tax_cents: 0,
      total_cents: 180,
    }, [
      {
        id: "line-negative",
        quantity: 1,
        unit_price_cents: 100,
        total_cents: 100,
        discount_allocated_cents: -10,
        effective_total_cents: 110,
        effective_net_cents: 110,
        vat_rate_bps: 0,
      },
      {
        id: "line-positive",
        quantity: 1,
        unit_price_cents: 100,
        total_cents: 100,
        discount_allocated_cents: 30,
        effective_total_cents: 70,
        effective_net_cents: 70,
        vat_rate_bps: 0,
      },
    ], vi.fn());

    expect(result.reconciled).toBe(false);
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "item_discount_out_of_range",
      "item_effective_money_out_of_range",
    ]));
    expect(result.lines[0]).toMatchObject({
      discountAllocated: -10,
      effectiveGross: 110,
    });
  });

  it("rejects invalid quantity and VAT without repairing persisted values", () => {
    const result = deriveOrderMoney(order, [
      {
        ...items[0]!,
        quantity: 0,
        vat_rate_bps: 10_001,
      },
      items[1]!,
    ], vi.fn());

    expect(result.reconciled).toBe(false);
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "item_quantity_out_of_range",
      "item_vat_rate_out_of_range",
    ]));
    expect(result.lines[0]).toMatchObject({ quantity: 0, vatRateBps: 10_001 });
  });

  it("does not let a failing diagnostic sink break the read fallback", () => {
    expect(() => deriveOrderMoney(
      { ...order, total_cents: 1 },
      undefined,
      () => { throw new Error("logger unavailable"); },
    )).not.toThrow();
  });

  it("emits the stable default diagnostic without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = deriveOrderMoney({ ...order, discount_cents: 9_000 });

    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "product_discount_out_of_range",
      "header_equation_mismatch",
    ]));
    expect(warn).toHaveBeenCalledWith(
      "commerce_order_money_unreconciled",
      expect.stringContaining('"orderId":"order-1"'),
    );
    warn.mockRestore();
  });

  it("exports every canonical header and item money column", () => {
    expect(ORDER_HEADER_MONEY_COLUMNS).toBe(
      "currency, subtotal_cents, discount_cents, shipping_cents, shipping_discount_cents, tax_cents, total_cents",
    );
    expect(ORDER_ITEM_MONEY_COLUMNS).toBe(
      "unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, vat_rate_bps",
    );
  });
});
