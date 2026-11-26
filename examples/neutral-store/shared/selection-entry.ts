import type { Locale, PurchaseMode, StoreConfig } from './config.ts';
import type { supportedLocales } from './locales.ts';
import { validateCart, type Cart, type CartLine, type OfferIssue } from './offer.ts';
import type { StarterCatalogueItem } from './catalogue-products.ts';
import { routes } from './routes.ts';

/**
 * The cart route reads a selection from these query parameters, and only these:
 * `line=<sku>:<quantity>` (repeated), `mode` and `cadence`. Every other parameter,
 * price-like ones included, is never read and stays in the address.
 */
export const selectionEntryParameter = Object.freeze({ line: 'line', mode: 'mode', cadence: 'cadence' } as const);

/** The platform's catalogue SKU grammar. A link for a SKU outside it is refused. */
const skuGrammar = /^[A-Za-z0-9._:-]{1,128}$/;
const quantityGrammar = /^(?:0|[1-9][0-9]{0,8})$/;
const cadenceGrammar = /^[1-9][0-9]{0,8}$/;
const maximumLines = 50;
const read = new Set<string>(Object.values(selectionEntryParameter));

export const isSelectionEntrySku = (sku: string): boolean => skuGrammar.test(sku);

export interface SelectionEntrySelection {
  mode: PurchaseMode;
  /** Subscription cadence in days; absent or null means the store's default cadence. */
  cadenceDays?: number | null;
  lines: readonly CartLine[];
}

/** Builds the localized cart address of a selection. Throws for a SKU outside the grammar, so a broken link fails where it is written. */
export function selectionEntryPath(locale: Locale, selection: SelectionEntrySelection): string {
  const query = new URLSearchParams();
  query.append(selectionEntryParameter.mode, selection.mode);
  if (selection.mode === 'subscription' && selection.cadenceDays != null) {
    if (!Number.isSafeInteger(selection.cadenceDays) || selection.cadenceDays < 1) throw new Error('starter_selection_entry_cadence_invalid');
    query.append(selectionEntryParameter.cadence, String(selection.cadenceDays));
  }
  if (!selection.lines.length || selection.lines.length > maximumLines) throw new Error('starter_selection_entry_lines_invalid');
  for (const { sku, quantity } of selection.lines) {
    if (!skuGrammar.test(sku)) throw new Error('starter_selection_entry_sku_invalid');
    if (!Number.isSafeInteger(quantity) || quantity < 0 || !quantityGrammar.test(String(quantity))) throw new Error('starter_selection_entry_quantity_invalid');
    query.append(selectionEntryParameter.line, `${sku}:${quantity}`);
  }
  return `${routes.cart[locale]}?${query}`;
}

export type SelectionEntryParse =
  | { kind: 'none'; ignored: string[] }
  | { kind: 'read'; candidate: Cart; ignored: string[] }
  | { kind: 'refused'; issues: OfferIssue[]; ignored: string[] };

/**
 * Reads an address into the cart shape `validateCart` takes. An address without a `line` is not an entry.
 * Only SKU, quantity, purchase mode and cadence are read; `ignored` names every other parameter.
 */
export function parseSelectionEntry(config: StoreConfig, query: URLSearchParams): SelectionEntryParse {
  const ignored: string[] = [], modes: string[] = [], cadences: string[] = [], lines: CartLine[] = [], issues: OfferIssue[] = [];
  let entry = false, overflow = false;
  for (const [name, value] of query) {
    if (!read.has(name)) { if (!ignored.includes(name)) ignored.push(name); continue; }
    if (name === selectionEntryParameter.mode) { modes.push(value); continue; }
    if (name === selectionEntryParameter.cadence) { cadences.push(value); continue; }
    entry = true;
    if (overflow) continue;
    if (lines.length + issues.length >= maximumLines) { overflow = true; continue; }
    const split = value.lastIndexOf(':');
    const sku = split < 0 ? '' : value.slice(0, split), quantity = value.slice(split + 1);
    if (!skuGrammar.test(sku)) { issues.push({ code: 'cart_invalid' }); continue; }
    if (!quantityGrammar.test(quantity)) { issues.push({ code: 'quantity_invalid', sku }); continue; }
    lines.push({ sku, quantity: Number(quantity) });
  }
  if (!entry) return { kind: 'none', ignored };
  const refuse = (found: OfferIssue[]): SelectionEntryParse => ({ kind: 'refused', issues: found, ignored });
  const invalid = refuse([{ code: 'cart_invalid' }]);
  if (overflow || issues.some(issue => issue.code === 'cart_invalid')) return invalid;
  if (modes.length > 1) return invalid;
  const mode = modes[0] ?? 'one_time';
  if (mode !== 'one_time' && mode !== 'subscription') return invalid;
  let cadenceDays: number | null = null;
  if (mode === 'subscription') {
    if (cadences.length > 1) return invalid;
    const cadence = cadences[0];
    if (cadence !== undefined && !cadenceGrammar.test(cadence)) return refuse([{ code: 'cadence_unavailable' }]);
    cadenceDays = cadence === undefined ? config.offer.defaultCadenceDays : Number(cadence);
  }
  if (issues.length) return refuse(issues);
  return { kind: 'read', candidate: { schemaVersion: 1, configuration: config.id, mode, cadenceDays, lines }, ignored };
}

/** `unbound`: the store has no catalogue binding and validates against its configured products. */
export type SelectionEntryCatalogue = 'loading' | 'ready' | 'unbound' | 'unavailable';

export type SelectionEntryDecision =
  | { kind: 'none' }
  | { kind: 'wait' }
  | { kind: 'catalogue_unavailable' }
  | { kind: 'refuse'; issues: OfferIssue[]; ignored: string[] }
  | { kind: 'apply' | 'ask'; cart: Cart; ignored: string[] }
  | { kind: 'same'; ignored: string[] };

/** Replace an empty cart, ask before replacing a different one, never merge. Nothing is validated before the catalogue answered. */
export function decideSelectionEntry(config: StoreConfig, input: {
  query: URLSearchParams; cart: Cart; products: readonly StarterCatalogueItem[]; catalogue: SelectionEntryCatalogue;
}): SelectionEntryDecision {
  if (!input.query.has(selectionEntryParameter.line)) return { kind: 'none' };
  if (input.catalogue === 'loading') return { kind: 'wait' };
  if (input.catalogue === 'unavailable') return { kind: 'catalogue_unavailable' };
  const parsed = parseSelectionEntry(config, input.query);
  if (parsed.kind === 'none') return { kind: 'none' };
  if (parsed.kind === 'refused') return { kind: 'refuse', issues: parsed.issues, ignored: parsed.ignored };
  const products = input.catalogue === 'unbound' ? config.offer.products : input.products;
  const validated = validateCart(config, parsed.candidate, 'checkout', products);
  if (!validated.ok) return { kind: 'refuse', issues: validated.issues, ignored: parsed.ignored };
  const { cart } = validated, held = input.cart;
  if (!held.lines.length) return { kind: 'apply', cart, ignored: parsed.ignored };
  const quantities = new Map(held.lines.map(line => [line.sku, line.quantity]));
  const same = held.mode === cart.mode && held.cadenceDays === cart.cadenceDays && held.lines.length === cart.lines.length
    && quantities.size === cart.lines.length && cart.lines.every(line => quantities.get(line.sku) === line.quantity);
  return same ? { kind: 'same', ignored: parsed.ignored } : { kind: 'ask', cart, ignored: parsed.ignored };
}

/** The address without `line`, `mode` and `cadence`. Every other query pair keeps its original bytes and order; the hash stays. */
export function withoutSelectionEntry(pathname: string, search: string, hash: string): string {
  const kept = search.replace(/^\?/, '').split('&').filter(pair => {
    if (!pair) return false;
    const name = new URLSearchParams(pair).keys().next().value;
    return name === undefined || !read.has(name);
  });
  return pathname + (kept.length ? `?${kept.join('&')}` : '') + hash;
}

type Text = Record<(typeof supportedLocales)[number], string>;

/** Managed buyer texts of the selection entry. A store that customises them re-applies them on upgrade. */
export const selectionEntryCopy = Object.freeze({
  refusalHeading: { en: "The link's selection could not be used", pl: 'Nie można użyć wyboru z linku' },
  refusalIntro: { en: 'Nothing from the link was added to your cart:', pl: 'Nic z linku nie zostało dodane do koszyka:' },
  questionHeading: { en: "Replace your cart with the link's selection?", pl: 'Zastąpić koszyk wyborem z linku?' },
  questionIntro: {
    en: 'Your cart already holds a different selection. Choose which one to keep; nothing changes until you choose.',
    pl: 'Twój koszyk zawiera już inny wybór. Wybierz, który zachować; do tego czasu nic się nie zmieni.',
  },
  offered: { en: 'From the link', pl: 'Z linku' },
  current: { en: 'Your cart now', pl: 'Twój obecny koszyk' },
  useSelection: { en: 'Use the selection from the link', pl: 'Użyj wyboru z linku' },
  keepCart: { en: 'Keep my cart', pl: 'Zachowaj mój koszyk' },
} satisfies Record<string, Text>);
