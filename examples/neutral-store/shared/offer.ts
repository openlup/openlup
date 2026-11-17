import { admitsLine, contains } from './subscription-offer.ts';
import type { PurchaseMode, StoreConfig } from './config.ts';
import { estimateOffer } from './offer-estimate.ts';

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
  lines: Array<CartLine & { baseUnitMinor: number; unitMinor: number; lineMinor: number }>;
  subtotalMinor: number;
  discountMinor: number;
  modeDiscountMinor: number;
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

/** Structural request identity is independent of current commercial membership. */
export function parseCart(configuration: string, input: unknown):
  | { ok: true; cart: Cart } | Extract<OfferResult, { ok: false }> {
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.lines)
    || (input.mode !== 'one_time' && input.mode !== 'subscription')) {
    return fail('cart_invalid');
  }
  if (input.configuration !== configuration) return fail('cart_configuration_changed');
  if (input.lines.length === 0) return fail('cart_empty');
  if (input.lines.length > 50) return fail('cart_invalid');
  const mode = input.mode;
  const cadenceDays = mode === 'subscription' ? input.cadenceDays : null;
  if (mode === 'subscription' && (typeof cadenceDays !== 'number' || !Number.isSafeInteger(cadenceDays) || cadenceDays < 1 || cadenceDays > 2_147_483_647)) return fail('cadence_unavailable');
  const issues: OfferIssue[] = [];
  const lines: CartLine[] = [];
  const seen = new Set<string>();
  for (const raw of input.lines) {
    if (!isRecord(raw) || typeof raw.sku !== 'string' || typeof raw.quantity !== 'number') {
      issues.push({ code: 'cart_invalid' });
      continue;
    }
    const sku = raw.sku;
    if (seen.has(sku)) issues.push({ code: 'duplicate_sku', sku });
    seen.add(sku);
    if (!Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > 99) {
      issues.push({ code: 'quantity_invalid', sku });
      continue;
    }
    lines.push({ sku, quantity: raw.quantity });
  }
  const cart: Cart = { schemaVersion: 1, configuration, mode,
    cadenceDays: typeof cadenceDays === 'number' ? cadenceDays : null,
    lines: lines.map(({ sku, quantity }) => ({ sku, quantity })) };
  if (issues.length > 0) return { ok: false,issues };
  return { ok: true, cart };
}

/** Current owned admission runs only for fresh work, after structural identity/replay. */
export function validateCart(config: StoreConfig, input: unknown, phase: 'checkout' | 'graduation' = 'checkout'): ReturnType<typeof parseCart> {
  const parsed = parseCart(config.id,input);
  if (!parsed.ok) return parsed;
  const { cart } = parsed, issues: OfferIssue[] = [], plan = config.subscriptionOffers.classic;
  if (cart.mode === 'subscription' && cart.lines.length > plan.maximumBaseLines) return fail('cart_invalid');
  if (cart.mode === 'subscription' && !contains(phase === 'checkout' ? plan.checkoutDays ?? plan.days : plan.days,cart.cadenceDays!)) return fail('cadence_unavailable');
  for (const line of cart.lines) {
    const product = config.offer.products.find(item => item.sku === line.sku);
    if (!product) { issues.push({ code: 'unknown_sku',sku: line.sku }); continue; }
    if (!product.permittedPurchaseModes.includes(cart.mode)) issues.push({ code: 'purchase_mode_unavailable',sku: line.sku });
    if (line.quantity > config.offer.maxUnits || cart.mode === 'subscription' && !admitsLine(plan,line.sku,cart.cadenceDays!,line.quantity)) {
      issues.push({ code: 'quantity_invalid',sku: line.sku });
    }
  }
  const units = cart.lines.reduce((sum,line) => sum+line.quantity,0);
  const minimum = cart.mode === 'subscription' ? Math.max(config.offer.minUnits,plan.checkoutMinimumBaseUnits ?? plan.minimumBaseUnits) : config.offer.minUnits;
  const maximum = cart.mode === 'subscription' ? Math.min(config.offer.maxUnits,plan.maximumUnits) : config.offer.maxUnits;
  if (units < minimum) issues.push({ code: 'minimum_units',limit: minimum });
  if (units > maximum) issues.push({ code: 'maximum_units',limit: maximum });
  return issues.length ? { ok: false,issues,...(issues.every(issue => issue.code === 'minimum_units') ? { selection: cart } : {}) } : parsed;
}

/** Local display estimate only; the native binding is the executable money authority. */
export function evaluateOffer(config: StoreConfig, input: unknown): OfferResult {
  const selected = validateCart(config, input);
  if (!selected.ok) return selected;
  const { cart } = selected;
  const quote = estimateOffer(config, cart.mode, cart.lines);
  if (![quote.subtotalMinor, quote.modeDiscountMinor, quote.shippingMinor, quote.totalMinor,
    ...quote.lines.flatMap(line => [line.unitMinor, line.lineMinor])].every(Number.isSafeInteger)) return fail('amount_overflow');
  return { ok: true, cart, quote: { ...quote, mode: cart.mode, cadenceDays: cart.cadenceDays } };
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
