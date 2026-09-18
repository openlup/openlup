export type CanonicalInvoicePositionTotals = {
  valid: true;
  grossCents: number;
  netCents: number;
  itemGrossCents: number;
  itemNetCents: number;
  itemCatalogGrossCents: number;
  itemDiscountAllocatedCents: number;
  deliveryGrossCents: number;
  deliveryNetCents: number;
  shippingGrossCents: number;
  shippingDiscountCents: number;
  items: CanonicalInvoiceItemPosition[];
};

export type CanonicalInvoiceItemPosition = {
  orderItemId: string;
  allocationOrdinal: number;
  quantity: number;
  unitGrossCents: number;
  unitNetCents: number;
  totalGrossCents: number;
  totalNetCents: number;
  catalogGrossCents: number;
  discountAllocatedCents: number;
  vatRateBps: number;
};

export type InvoicePositionTotals = CanonicalInvoicePositionTotals | {
  valid: false;
  grossCents: null;
  netCents: null;
};

type ParsedItem = CanonicalInvoiceItemPosition;

type ParsedDelivery = {
  totalGrossCents: number;
  totalNetCents: number;
  shippingGrossCents: number;
  shippingDiscountCents: number;
  vatRateBps: number;
};

export function sumCanonicalInvoicePositions(value: unknown): InvoicePositionTotals {
  if (!Array.isArray(value) || value.length === 0) return invalidTotals();
  const orderItemIds = new Set<string>();
  const allocationOrdinals = new Set<number>();
  const items: ParsedItem[] = [];
  let delivery: ParsedDelivery | null = null;

  for (const entry of value) {
    if (!isRecord(entry)) return invalidTotals();
    const positionKind = entry.positionKind;
    if (positionKind !== "item" && positionKind !== "delivery") return invalidTotals();
    const vatRateBps = readVatRateBps(entry.vatRateBps, entry.vatRate);
    if (!positiveInteger(entry.quantity) || vatRateBps === null) return invalidTotals();
    if (!moneyInteger(entry.totalGrossMinor) || !moneyInteger(entry.totalNetMinor)) return invalidTotals();
    if (!moneyInteger(entry.unitGrossMinor) || !moneyInteger(entry.unitNetMinor)) return invalidTotals();
    if (entry.totalNetMinor > entry.totalGrossMinor) return invalidTotals();
    if (entry.totalNetMinor !== netFromGross(entry.totalGrossMinor, vatRateBps)) return invalidTotals();
    if (entry.unitGrossMinor !== roundedUnit(entry.totalGrossMinor, entry.quantity)) return invalidTotals();
    if (entry.unitNetMinor !== roundedUnit(entry.totalNetMinor, entry.quantity)) return invalidTotals();

    if (positionKind === "item") {
      if (delivery !== null) return invalidTotals();
      if (typeof entry.orderItemId !== "string" || entry.orderItemId.trim() !== entry.orderItemId ||
        entry.orderItemId.length === 0 || orderItemIds.has(entry.orderItemId)) {
        return invalidTotals();
      }
      if (!positiveInteger(entry.allocationOrdinal) ||
        allocationOrdinals.has(entry.allocationOrdinal) ||
        entry.allocationOrdinal <= (items.at(-1)?.allocationOrdinal ?? 0)) {
        return invalidTotals();
      }
      if (!moneyInteger(entry.catalogTotalGrossMinor) || !moneyInteger(entry.discountAllocatedMinor)) {
        return invalidTotals();
      }
      if (entry.discountAllocatedMinor > entry.catalogTotalGrossMinor ||
        safeAdd(entry.totalGrossMinor, entry.discountAllocatedMinor) !== entry.catalogTotalGrossMinor) {
        return invalidTotals();
      }
      orderItemIds.add(entry.orderItemId);
      allocationOrdinals.add(entry.allocationOrdinal);
      items.push({
        orderItemId: entry.orderItemId,
        allocationOrdinal: entry.allocationOrdinal,
        quantity: entry.quantity,
        unitGrossCents: entry.unitGrossMinor,
        unitNetCents: entry.unitNetMinor,
        totalGrossCents: entry.totalGrossMinor,
        totalNetCents: entry.totalNetMinor,
        catalogGrossCents: entry.catalogTotalGrossMinor,
        discountAllocatedCents: entry.discountAllocatedMinor,
        vatRateBps,
      });
    } else {
      if (delivery !== null || entry.orderItemId !== null || entry.allocationOrdinal !== undefined ||
        entry.quantity !== 1 || entry.totalGrossMinor <= 0 ||
        entry.unitGrossMinor !== entry.totalGrossMinor || entry.unitNetMinor !== entry.totalNetMinor ||
        !moneyInteger(entry.shippingGrossMinor) || !moneyInteger(entry.shippingDiscountMinor) ||
        entry.shippingDiscountMinor > entry.shippingGrossMinor ||
        entry.shippingGrossMinor - entry.shippingDiscountMinor !== entry.totalGrossMinor) {
        return invalidTotals();
      }
      delivery = {
        totalGrossCents: entry.totalGrossMinor,
        totalNetCents: entry.totalNetMinor,
        shippingGrossCents: entry.shippingGrossMinor,
        shippingDiscountCents: entry.shippingDiscountMinor,
        vatRateBps,
      };
    }
  }

  if (items.length === 0) return invalidTotals();
  if (delivery && items.some((item) => item.vatRateBps !== delivery.vatRateBps)) return invalidTotals();

  const itemGrossCents = safeSum(items.map((item) => item.totalGrossCents));
  const itemNetCents = safeSum(items.map((item) => item.totalNetCents));
  const itemCatalogGrossCents = safeSum(items.map((item) => item.catalogGrossCents));
  const itemDiscountAllocatedCents = safeSum(items.map((item) => item.discountAllocatedCents));
  if ([itemGrossCents, itemNetCents, itemCatalogGrossCents, itemDiscountAllocatedCents].some((sum) => sum === null)) {
    return invalidTotals();
  }
  if (safeAdd(itemGrossCents!, itemDiscountAllocatedCents!) !== itemCatalogGrossCents) return invalidTotals();
  try {
    const independentlyAllocated = allocateDiscountedGrossTotals(
      items.map((item) => item.catalogGrossCents),
      itemGrossCents!,
    );
    if (items.some((item, index) => item.totalGrossCents !== independentlyAllocated[index])) return invalidTotals();
  } catch {
    return invalidTotals();
  }

  const deliveryGrossCents = delivery?.totalGrossCents ?? 0;
  const deliveryNetCents = delivery?.totalNetCents ?? 0;
  const grossCents = safeAdd(itemGrossCents!, deliveryGrossCents);
  const netCents = safeAdd(itemNetCents!, deliveryNetCents);
  if (grossCents === null || netCents === null) return invalidTotals();

  return {
    valid: true,
    grossCents,
    netCents,
    itemGrossCents: itemGrossCents!,
    itemNetCents: itemNetCents!,
    itemCatalogGrossCents: itemCatalogGrossCents!,
    itemDiscountAllocatedCents: itemDiscountAllocatedCents!,
    deliveryGrossCents,
    deliveryNetCents,
    shippingGrossCents: delivery?.shippingGrossCents ?? 0,
    shippingDiscountCents: delivery?.shippingDiscountCents ?? 0,
    items,
  };
}

function invalidTotals(): InvoicePositionTotals {
  return { valid: false, grossCents: null, netCents: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function moneyInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function readVatRateBps(value: unknown, displayValue: unknown): number | null {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000) return null;
  if (typeof displayValue !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(displayValue)) return null;
  const [whole, fraction = ""] = displayValue.split(".");
  const parsed = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(parsed) && parsed === value ? Number(value) : null;
}

function netFromGross(gross: number, vatRateBps: number): number {
  const denominator = BigInt(10_000 + vatRateBps);
  return Number((BigInt(gross) * 10_000n + denominator / 2n) / denominator);
}

function roundedUnit(total: number, quantity: number): number {
  const numerator = BigInt(total) * 2n + BigInt(quantity);
  return Number(numerator / (BigInt(quantity) * 2n));
}

function safeAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function safeSum(values: number[]): number | null {
  let sum = 0;
  for (const value of values) {
    const next = safeAdd(sum, value);
    if (next === null) return null;
    sum = next;
  }
  return sum;
}

// Independent watchdog-boundary implementation of the order writer's
// largest-remainder discount allocation. It deliberately does not import the
// accounting domain's verifier, so the two defenses cannot share one defect.
function allocateDiscountedGrossTotals(lineTotals: number[], chargedTotal: number): number[] {
  const linesTotal = lineTotals.reduce((sum, total) => sum + total, 0);
  const discount = linesTotal - chargedTotal;
  if (!Number.isSafeInteger(chargedTotal) || chargedTotal < 0 || discount < 0 ||
    lineTotals.some((total) => !Number.isSafeInteger(total) || total < 0)) {
    throw new Error("order_money_invoice_allocation_invalid");
  }
  if (discount === 0) return lineTotals;
  if (linesTotal === 0) throw new Error("order_money_invoice_allocation_zero_spread");

  const denominator = BigInt(linesTotal);
  const discountExact = BigInt(discount);
  const scaled = lineTotals.map((total) => {
    const product = BigInt(total) * discountExact;
    return { base: product / denominator, remainder: product % denominator };
  });
  const allocations = scaled.map(({ base }) => Number(base));
  let remainder = discount - allocations.reduce((sum, total) => sum + total, 0);
  const order = scaled
    .map((value, index) => ({ index, fraction: value.remainder }))
    .sort((left, right) => left.fraction === right.fraction
      ? left.index - right.index
      : left.fraction > right.fraction ? -1 : 1);
  for (const { index } of order) {
    if (remainder <= 0) break;
    allocations[index] += 1;
    remainder -= 1;
  }
  return lineTotals.map((total, index) => total - allocations[index]);
}
