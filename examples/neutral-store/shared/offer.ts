import type { PurchaseMode, StoreConfig } from './config.ts';

export interface CartLine {
  sku: string;
  quantity: number;
}

export interface Cart {
  schemaVersion: 1;
  configuration: string;
  mode: PurchaseMode;
  cadenceDays: number | null;
  lines: CartLine[];
}

export interface OfferQuote {
  lines: Array<CartLine & { unitMinor: number; lineMinor: number }>;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  currency: string;
  mode: PurchaseMode;
  cadenceDays: number | null;
}

export type OfferIssue = {
  code: 'cart_invalid' | 'cart_configuration_changed' | 'cart_empty' | 'unknown_sku'
    | 'quantity_invalid' | 'duplicate_sku' | 'purchase_mode_unavailable'
    | 'cadence_unavailable' | 'minimum_units' | 'maximum_units' | 'amount_overflow';
  sku?: string;
  limit?: number;
};

export type OfferResult =
  | { ok: true; cart: Cart; quote: OfferQuote }
  | { ok: false; issues: OfferIssue[]; selection?: Cart };

/** UI estimates and host admission use exactly this rule. Engine quotes remain authoritative. */
export function evaluateOffer(config: StoreConfig, input: unknown): OfferResult {
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.lines)
    || (input.mode !== 'one_time' && input.mode !== 'subscription')) {
    return fail('cart_invalid');
  }
  if (input.configuration !== config.id) return fail('cart_configuration_changed');
  if (input.lines.length === 0) return fail('cart_empty');
  if (input.lines.length > config.offer.products.length) return fail('cart_invalid');
  const mode = input.mode;
  const cadenceDays = mode === 'subscription' ? input.cadenceDays : null;
  if (mode === 'subscription' && (typeof cadenceDays !== 'number'
    || !config.offer.cadenceDays.includes(cadenceDays))) return fail('cadence_unavailable');
  const issues: OfferIssue[] = [];
  const lines: OfferQuote['lines'] = [];
  const seen = new Set<string>();
  for (const raw of input.lines) {
    if (!isRecord(raw) || typeof raw.sku !== 'string' || typeof raw.quantity !== 'number') {
      issues.push({ code: 'cart_invalid' });
      continue;
    }
    const sku = raw.sku;
    const product = config.offer.products.find(item => item.sku === sku);
    if (!product) {
      issues.push({ code: 'unknown_sku', sku });
      continue;
    }
    if (seen.has(sku)) issues.push({ code: 'duplicate_sku', sku });
    seen.add(sku);
    if (!Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > config.offer.maxUnits) {
      issues.push({ code: 'quantity_invalid', sku });
      continue;
    }
    if (!product.permittedPurchaseModes.includes(mode)) {
      issues.push({ code: 'purchase_mode_unavailable', sku });
    }
    lines.push({ sku, quantity: raw.quantity, unitMinor: product.unitPrice.amountMinor,
      lineMinor: product.unitPrice.amountMinor * raw.quantity });
  }
  const units = lines.reduce((total, line) => total + line.quantity, 0);
  if (units < config.offer.minUnits) issues.push({ code: 'minimum_units', limit: config.offer.minUnits });
  if (units > config.offer.maxUnits) issues.push({ code: 'maximum_units', limit: config.offer.maxUnits });
  const subtotalMinor = lines.reduce((total, line) => total + line.lineMinor, 0);
  const discountMinor = mode === 'subscription'
    ? Math.floor(subtotalMinor * config.offer.subscriptionDiscountBps / 10000) : 0;
  const net = subtotalMinor - discountMinor;
  const shippingMinor = net >= config.offer.freeShippingFromMinor ? 0 : config.offer.shippingMinor;
  const totalMinor = net + shippingMinor;
  if (![subtotalMinor, subtotalMinor * config.offer.subscriptionDiscountBps,
    discountMinor, shippingMinor, totalMinor].every(Number.isSafeInteger)) {
    issues.push({ code: 'amount_overflow' });
  }
  const cart: Cart = { schemaVersion: 1, configuration: config.id, mode,
    cadenceDays: typeof cadenceDays === 'number' ? cadenceDays : null,
    lines: lines.map(({ sku, quantity }) => ({ sku, quantity })) };
  if (issues.length > 0) {
    // A safe partial composition may persist, but it has no eligible checkout quote.
    return issues.every(issue => issue.code === 'minimum_units')
      ? { ok: false, issues, selection: cart }
      : { ok: false, issues };
  }
  return { ok: true, cart, quote: { lines, subtotalMinor, discountMinor, shippingMinor,
    totalMinor, currency: config.market.currency, mode, cadenceDays: cart.cadenceDays } };
}

export function emptyCart(config: StoreConfig): Cart {
  return { schemaVersion: 1, configuration: config.id, mode: 'one_time', cadenceDays: null, lines: [] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: OfferIssue['code']): OfferResult {
  return { ok: false, issues: [{ code }] };
}
