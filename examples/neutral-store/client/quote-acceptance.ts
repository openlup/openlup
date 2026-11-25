import { isOfferQuoteView } from './live-quote.ts';
import { ACQUISITION_TERMS_CAPABILITY } from '@openlup/platform/pricing/contracts';
import { acquisitionTermsSchema } from '@openlup/platform/pricing/browser';
import type { ActionInput } from '../shared/api.ts';
import { isRecord, type OfferQuote } from '../shared/offer.ts';
import { quoteCopy } from '../owned/quote-copy.ts';
import type { PageContext } from './context.ts';
import { act } from './api.ts';
import { el } from './dom.ts';

function observe(quote: OfferQuote & Record<string, unknown>, binding: string) {
  const total = quote.expectedTotal;
  if (!isRecord(total) || total.amountMinor !== quote.totalMinor || total.currency !== quote.currency) return;
  if (quote.mode === 'subscription' && (!Number.isSafeInteger(quote.cadenceDays) || quote.cadenceDays! <= 0)) return;
  const acceptance = quote.quoteAcceptance;
  const policy = quote.acquisitionTerms === undefined ? undefined : acquisitionTermsSchema.safeParse(quote.acquisitionTerms);
  const validUntil = policy && typeof quote.validUntil === 'string' ? Date.parse(quote.validUntil) : Infinity;
  if (policy && (!policy.success || typeof acceptance !== 'string' || !acceptance.trim() ||
    !Number.isFinite(validUntil) || validUntil <= Date.now() ||
    typeof quote.secondTotalMinor !== 'number' || !Number.isSafeInteger(quote.secondTotalMinor) || quote.secondTotalMinor < 0)) return;
  if (!policy && acceptance !== null) return;
  const terms = JSON.stringify([
    quote.mode, quote.cadenceDays, quote.currency,
    quote.lines.map(line => [line.sku, line.quantity, line.unitMinor, line.lineMinor, line.baseUnitMinor]),
    quote.subtotalMinor, quote.discountMinor, quote.modeDiscountMinor, quote.shippingMinor, quote.totalMinor,
    total.amountMinor, total.currency, policy?.data, quote.secondTotalMinor,
  ]);
  return { binding, terms, acceptance, total, validUntil };
}

/** Equal observations retain the acceptance and deadline the customer reviewed. */
export function createQuoteAcceptance(context: PageContext, summary: HTMLElement) {
  let form: HTMLFormElement;
  let generation = 0;
  let current: ReturnType<typeof observe>;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const copy = quoteCopy[context.locale];
  const base = () => ({ cart: context.getCart(), configuration: context.config.id, country: context.config.market.country,
    termsRevision: context.config.legal.revision, acquisitionCapability: ACQUISITION_TERMS_CAPABILITY });
  const binding = (input: ActionInput) => JSON.stringify(Object.fromEntries(Object.entries(input)
    .filter(([key]) => !['termsAccepted','quoteAcceptance','expectedTotal','locale'].includes(key)).sort(([a],[b]) => a.localeCompare(b))));
  const values = () => ({ ...Object.fromEntries(new FormData(form).entries()), ...base() });
  const consent = () => form.querySelector<HTMLInputElement>('input[name="termsAccepted"]')!;
  function clear() {
    clearTimeout(expiry);
    current = undefined;
    consent().checked = false;
  }
  async function refresh(input: ActionInput) {
    const ownGeneration = ++generation;
    const scope = binding(input);
    if (current && (current.binding !== scope || current.validUntil <= Date.now())) clear();
    const reviewed = consent().checked ? current : undefined;
    summary.replaceChildren(el('p', {}, copy.loading));
    const result = await act('offer.validate',input,crypto.randomUUID());
    if (ownGeneration !== generation) return false;
    if (!form.isConnected) { clear(); return false; }
    const quote = result.ok && isOfferQuoteView(result.value) ? result.value : undefined;
    if (!quote || quote.currency !== context.config.market.currency) {
      clear();
      summary.replaceChildren(el('p', {},copy.unavailable),el('code', {},result.ok ? 'starter_quote_unavailable' : result.code));
      return false;
    }
    const next = quote.mode === 'subscription' ? observe(quote, scope) : undefined;
    if (quote.mode === 'subscription' && !next) {
      clear();
      summary.replaceChildren(el('p', {},copy.unavailable));
      return false;
    }
    if (!reviewed || reviewed !== current || !next || reviewed.terms !== next.terms ||
      reviewed.validUntil <= Date.now() || !consent().checked) {
      clear();
      current = next;
      if (next && Number.isFinite(next.validUntil)) expiry = setTimeout(() => {
        if (current !== next) return;
        clear();
        if (form.isConnected) summary.replaceChildren(el('p', {},copy.refresh));
      }, Math.max(0,next.validUntil - Date.now()));
    }
    summary.replaceChildren(context.fragments.checkoutSummary(context,quote));
    if (typeof quote.secondTotalMinor === 'number' && Number.isSafeInteger(quote.secondTotalMinor)) {
      summary.append(el('p', {},`${copy.second}: ${context.money(quote.secondTotalMinor)}`));
    }
    return true;
  }
  return { input: base,
    attach(element: HTMLElement) {
      if (form) clear();
      ++generation;
      const attached = form = element as HTMLFormElement;
      attached.addEventListener('change',event => {
        if (attached === form && (event.target as HTMLInputElement).name !== 'termsAccepted') void refresh(values());
      });
      queueMicrotask(() => { if (attached === form && form.isConnected) void refresh(values()); });
    },
    refused(code: string) {
      if (code === 'starter_quote_refresh_required' || code.startsWith('acquisition_terms_')) {
        ++generation; clear(); summary.replaceChildren(el('p', {},copy.refresh));
      }
    },
    async prepare(input: ActionInput): Promise<ActionInput | null> {
      if (context.getCart().mode === 'one_time') return input;
      const reviewed = current?.binding === binding(input) && consent().checked ? current : undefined;
      const refreshed = await refresh(input);
      if (!refreshed) return null;
      if (reviewed && reviewed === current && form.isConnected && consent().checked && reviewed.validUntil > Date.now()) {
        return { ...input,quoteAcceptance: reviewed.acceptance,expectedTotal: reviewed.total };
      }
      if (current && current.validUntil <= Date.now()) clear();
      summary.append(el('p', {},copy.refresh));
      return null;
    },
  };
}
