import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BundlePriceBreakdown } from "./bundleSummaryParts";
import { formatMoney } from "./configuratorPricing";

/**
 * The price ladder is the strictest surface in the module: it is the only place
 * the customer reads what they are about to be charged.
 *
 * Two invariants are pinned here and must survive any restyling.
 *   1. EXACTLY ONE `aria-live` region in the LADDER announces an amount, and it
 *      is always `order-total-amount` — the sum actually charged. Scoped
 *      deliberately: the surrounding card also announces each flavour quantity
 *      from `FlavorMixEditor`, which is not money and is not this file's subject.
 *   2. The ladder adds up on screen: struck list price − discount (+ delivery)
 *      = „Razem dziś".
 */

function renderBreakdown({
  productSavingsMinor,
  productPayableMinor = 10_728,
  totalPriceMinor = 10_728,
  shippingGrossMinor = 0,
  shippingDiscountMinor = 0,
  startDiscountPercent = null,
  compact = false,
}: {
  productSavingsMinor: number;
  productPayableMinor?: number;
  totalPriceMinor?: number;
  shippingGrossMinor?: number;
  shippingDiscountMinor?: number;
  startDiscountPercent?: number | null;
  compact?: boolean;
}) {
  return render(
    <BundlePriceBreakdown
      productSavingsMinor={productSavingsMinor}
      productPayableMinor={productPayableMinor}
      shippingGrossMinor={shippingGrossMinor}
      shippingDiscountMinor={shippingDiscountMinor}
      totalCans={18}
      totalPriceMinor={totalPriceMinor}
      anchorPriceMinor={26_820}
      startDiscountPercent={startDiscountPercent}
      priceText={formatMoney(totalPriceMinor, "pl")}
      compact={compact}
      lang="pl"
    />,
  );
}

/** The one-live-AMOUNT invariant, asserted over the whole rendered ladder. */
function liveRegions(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[aria-live]"));
}

function monetaryRowOrder(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll(
      '[data-testid="product-catalog-row"], [data-testid="order-discount-row"], [data-testid="product-payable-row"], [data-testid="shipping-row"], [data-testid="order-total-row"]',
    ),
  ).map((row) => row.getAttribute("data-testid"));
}

describe("BundlePriceBreakdown", () => {
  it("shows catalog price, product discount, payable products, delivery, and one final total", () => {
    const { container } = renderBreakdown({
      productSavingsMinor: 16_092,
      shippingGrossMinor: 1_500,
      shippingDiscountMinor: 1_500,
      startDiscountPercent: 50,
    });

    // 268,20 zł catalog price, struck, never a second live amount.
    expect(screen.getByTestId("product-catalog-row")).toHaveTextContent("18 puszek łącznie");
    expect(screen.getByTestId("product-catalog-amount")).toHaveTextContent("268,20 zł");
    expect(screen.getByTestId("product-catalog-amount")).toHaveClass("line-through");

    // The discount names its own percent, and that percent comes from the quote.
    const rows = screen.getAllByTestId("order-discount-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Rabat na start −50%");
    expect(rows[0]).toHaveTextContent("−160,92 zł");

    // Delivery is free here, so „Produkty po rabacie" would carry 107,28 zł and
    // „Razem dziś" would carry 107,28 zł two rows later. The ladder states a
    // number once; the row returns as soon as delivery costs something (see the
    // paid-delivery case below).
    expect(screen.queryByTestId("product-payable-row")).toBeNull();
    expect(screen.getByTestId("shipping-row")).toHaveTextContent("Dostawa");
    expect(screen.getByTestId("shipping-row")).toHaveTextContent("Gratis");

    expect(monetaryRowOrder(container)).toEqual([
      "product-catalog-row",
      "order-discount-row",
      "shipping-row",
      "order-total-row",
    ]);

    expect(screen.getByTestId("order-total-row")).toHaveTextContent("Razem dziś");
    expect(screen.getByTestId("order-total-row")).toHaveTextContent("107,28 zł");

    // Invariant 1: exactly one live region in the ladder, and it is the charged sum.
    expect(liveRegions(container)).toEqual([screen.getByTestId("order-total-amount")]);
    expect(screen.getByTestId("product-catalog-amount")).not.toHaveAttribute("aria-live");
    // The payable amount is not rendered under free delivery; the paid-delivery
    // case below asserts it is silent when it IS rendered.
  });

  it("falls back to the generic discount label when no starter percent resolved", () => {
    renderBreakdown({ productSavingsMinor: 4_235 });

    expect(screen.getAllByTestId("order-discount-row")).toHaveLength(1);
    expect(screen.getByTestId("order-discount-row")).toHaveTextContent("Rabat na produkty");
    expect(screen.getByTestId("order-discount-row")).toHaveTextContent("−42,35 zł");
  });

  it("keeps paid delivery its own row and folds it into the total", () => {
    const { container } = renderBreakdown({
      productSavingsMinor: 2_682,
      productPayableMinor: 24_138,
      totalPriceMinor: 25_638,
      shippingGrossMinor: 1_500,
      startDiscountPercent: 10,
    });

    // 268,20 − 26,82 = 241,38 products, + 15,00 delivery = 256,38 charged.
    expect(screen.getByTestId("product-catalog-amount")).toHaveTextContent("268,20 zł");
    expect(screen.getByTestId("order-discount-row")).toHaveTextContent("−26,82 zł");
    expect(screen.getByTestId("product-payable-row")).toHaveTextContent("241,38 zł");
    // Delivery costs money here, so the payable row is not a duplicate of the
    // total and stays — silent, as every amount but the total must be.
    expect(screen.getByTestId("product-payable-amount")).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("shipping-row")).toHaveTextContent("15,00 zł");
    expect(screen.getByTestId("order-total-row")).toHaveTextContent("256,38 zł");
    expect(liveRegions(container)).toEqual([screen.getByTestId("order-total-amount")]);
  });

  it("still shows the total row when there is no delivery line", () => {
    const { container } = renderBreakdown({
      productSavingsMinor: 2_682,
      productPayableMinor: 24_138,
      totalPriceMinor: 24_138,
    });

    expect(screen.queryByText("Dostawa")).not.toBeInTheDocument();
    expect(screen.getByTestId("order-total-row")).toHaveTextContent("241,38 zł");
    // With no delivery line at all, the payable amount and „Razem dziś" are the
    // same 241,38 zł, so the ladder prints it once — on the total.
    expect(screen.queryByTestId("product-payable-amount")).toBeNull();
    expect(liveRegions(container)).toEqual([screen.getByTestId("order-total-amount")]);
  });

  it("keeps the product discount and waived delivery separate on mobile", () => {
    const { container } = renderBreakdown({
      productSavingsMinor: 16_092,
      shippingGrossMinor: 1_500,
      shippingDiscountMinor: 1_500,
      startDiscountPercent: 50,
      compact: true,
    });

    expect(screen.getByTestId("product-catalog-amount")).toHaveTextContent("268,20 zł");
    expect(screen.getByTestId("order-discount-row")).toHaveTextContent("Rabat na start −50%");
    expect(screen.getByTestId("order-discount-row")).toHaveTextContent("−160,92 zł");
    // Same reason as above: free delivery makes the payable row a duplicate of
    // the total.
    expect(screen.queryByTestId("product-payable-row")).toBeNull();
    expect(screen.getByTestId("shipping-row")).toHaveTextContent("Dostawa");
    expect(screen.getByTestId("shipping-row")).toHaveTextContent("Gratis");
    expect(screen.getByTestId("order-total-row")).toHaveTextContent("107,28 zł");
    expect(monetaryRowOrder(container)).toEqual([
      "product-catalog-row",
      "order-discount-row",
      "shipping-row",
      "order-total-row",
    ]);
    expect(liveRegions(container)).toEqual([screen.getByTestId("order-total-amount")]);
  });
});
