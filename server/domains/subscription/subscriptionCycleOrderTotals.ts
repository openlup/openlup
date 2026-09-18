import { splitIncludedVat, type quoteLineSchema } from "../../../src/domains/commerce/contracts.js";
import { COMMERCE_CONTRACT_VERSION, type CommerceCurrency } from "../../../src/domains/commerce/types.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";

/**
 * The `orderSnapshot` / `pricingSnapshot` money builders for an off-session
 * renewal cycle, extracted verbatim from `buildSubscriptionCycleSnapshots.ts`
 * so they can be exercised without a database client, then extended with an
 * optional order-level gross discount.
 *
 * With `discountTotalGrossMinor` null or 0 the output is byte-identical to the
 * pre-extraction builders — that equality is the whole regression proof and is
 * pinned literally in `subscriptionCycleOrderTotals.test.ts`.
 *
 * With a positive discount the split follows the same arithmetic the
 * cycle-order RPC accepts as its "quote expected net"
 * (`20260714170003_canonical_order_money.sql`): the discount is tax-inclusive
 * at the single line VAT rate, `netTotal` drops by the discount's net part, and
 * `taxTotal` is whatever is left of the gross total. Mixed VAT rates are
 * rejected here rather than one layer later, because the RPC's own
 * `subscription_cycle_order_mixed_vat_rates` guard would surface as an opaque
 * RPC failure on the renewal path.
 *
 * Nothing in this module reads a clock or any other ambient value: every output
 * is a pure function of its arguments. Dunning replays a failed cycle with the
 * same inputs and must recompute the same money.
 */

type QuoteLine = ReturnType<typeof quoteLineSchema.parse>;

export interface OrderSnapshotInput {
  currency: string;
  lines: QuoteLine[];
  /** Order-level tax-inclusive gross discount. Null or 0 means "no discount". */
  discountTotalGrossMinor?: number | null;
  /**
   * Currencies this deployment will price a renewal cycle in. Injected rather
   * than assumed; the default is what ships today, so nothing changes for a
   * caller that passes none.
   */
  acceptedCurrencies?: readonly string[];
}

/**
 * Narrows a runtime currency string to one this deployment accepts, or refuses
 * by name. Replaces the `as` casts the renewal path used to apply to
 * `due.currency`: the value flowing through is the actual runtime string, and
 * the narrowing is checked instead of asserted.
 *
 * The accepted set now comes from the deployment's settlement profile rather
 * than from a frozen one-member list in this module. A cycle's money is
 * recomputed on every dunning replay and compared against what the store
 * already holds, so the set has to be the same stated configuration the quote
 * path uses; two lists would disagree the first time one of them moved. The
 * parameter stays, so a caller with its own set — every existing test — is
 * unaffected.
 */
export function acceptedCycleCurrency(
  currency: string,
  accepted: readonly string[] = readSettlementProfile(process.env).acceptedCurrencies,
): CommerceCurrency {
  if (!accepted.includes(currency)) {
    throw new Error(`Unsupported currency for subscription cycle snapshot: ${currency}`);
  }
  return currency as CommerceCurrency;
}

export function buildOrderSnapshot({
  currency,
  lines,
  discountTotalGrossMinor,
  acceptedCurrencies,
}: OrderSnapshotInput): Record<string, unknown> {
  acceptedCycleCurrency(currency, acceptedCurrencies);

  const subtotalGrossMinor = lines.reduce(
    (sum, line) => sum + line.lineSubtotalGross.amountMinor,
    0,
  );
  const netTotalMinor = lines.reduce((sum, line) => sum + line.tax.netAmount.amountMinor, 0);
  const taxTotalMinor = lines.reduce((sum, line) => sum + line.tax.vatAmount.amountMinor, 0);

  const totals = buildTotals({
    currency,
    lines,
    subtotalGrossMinor,
    netTotalMinor,
    taxTotalMinor,
    discountTotalGrossMinor: discountTotalGrossMinor ?? 0,
  });

  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    source: "subscription.own_engine.v0",
    status: "pending_payment",
    paymentStatus: "pending",
    currency,
    taxIncluded: true,
    lines,
    totals,
  };
}

function buildTotals({
  currency,
  lines,
  subtotalGrossMinor,
  netTotalMinor,
  taxTotalMinor,
  discountTotalGrossMinor,
}: {
  currency: string;
  lines: QuoteLine[];
  subtotalGrossMinor: number;
  netTotalMinor: number;
  taxTotalMinor: number;
  discountTotalGrossMinor: number;
}): Record<string, unknown> {
  if (discountTotalGrossMinor === 0) {
    return {
      subtotalGross: money(subtotalGrossMinor, currency),
      discountTotalGross: money(0, currency),
      totalGross: money(subtotalGrossMinor, currency),
      netTotal: money(netTotalMinor, currency),
      taxTotal: money(taxTotalMinor, currency),
    };
  }

  if (!Number.isInteger(discountTotalGrossMinor) || discountTotalGrossMinor < 0) {
    throw new Error(
      `Subscription cycle discount must be a non-negative integer minor amount, received ${discountTotalGrossMinor}`,
    );
  }
  if (discountTotalGrossMinor > subtotalGrossMinor) {
    throw new Error(
      `Subscription cycle discount ${discountTotalGrossMinor} exceeds subtotal ${subtotalGrossMinor}`,
    );
  }

  const vatRateBps = assertSingleVatRate(lines);
  const { netMinor: discountNetMinor, vatMinor: discountVatMinor } = splitIncludedVat(
    discountTotalGrossMinor,
    vatRateBps,
  );
  const totalGrossMinor = subtotalGrossMinor - discountTotalGrossMinor;
  const discountedNetMinor = netTotalMinor - discountNetMinor;
  const discountedTaxMinor = totalGrossMinor - discountedNetMinor;
  if (discountedTaxMinor !== taxTotalMinor - discountVatMinor) {
    throw new Error(
      "Subscription cycle discounted VAT does not reconcile with the line VAT sum",
    );
  }

  return {
    subtotalGross: money(subtotalGrossMinor, currency),
    discountTotalGross: money(discountTotalGrossMinor, currency),
    totalGross: money(totalGrossMinor, currency),
    netTotal: money(discountedNetMinor, currency),
    taxTotal: money(discountedTaxMinor, currency),
  };
}

/**
 * The cycle-order RPC allocates one order-level discount across the lines at a
 * single frozen VAT rate. Two rates in one cycle have no correct allocation, so
 * the caller is told here, with the rates named.
 */
export function assertSingleVatRate(lines: QuoteLine[]): number {
  const rates = [...new Set(lines.map((line) => line.tax.vatRateBps))];
  if (rates.length !== 1) {
    throw new Error(
      `Subscription cycle discount requires a single VAT rate, found [${rates.join(", ")}]`,
    );
  }
  return rates[0];
}

export function buildPricingSnapshot({
  subscriptionId,
  scheduledAt,
  cycleNumber,
  totals,
  provenance,
}: {
  subscriptionId: string;
  scheduledAt: string;
  cycleNumber: number;
  totals: Record<string, unknown>;
  provenance?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    source: "subscription.own_engine.v0",
    subscriptionId,
    scheduledAt,
    cycleNumber,
    totals,
  };
  // Omitted entirely when absent, so an ordinary renewal keeps its exact
  // pre-extraction snapshot shape.
  if (provenance) snapshot.provenance = provenance;
  return snapshot;
}

/**
 * One money value in the currency its order is priced in. The currency is an
 * argument, never a constant: the same builder serves any merchant.
 */
export function money(
  amountMinor: number,
  currency: string,
): { amountMinor: number; currency: string } {
  return { amountMinor, currency };
}
