import { isOfferQuoteView } from './live-quote.ts';
import { ACQUISITION_TERMS_CAPABILITY } from '@openlup/platform/pricing/contracts';
import { acquisitionTermsSchema } from '@openlup/platform/pricing/browser';
import type { ActionInput } from '../shared/api.ts';
import type { LocaleCopy } from '../shared/locales.ts';
import { isRecord, type OfferQuote } from '../shared/offer.ts';
import { quoteCopy } from '../owned/quote-copy.ts';
import type { PageContext } from './context.ts';
import { act } from './api.ts';
import { el } from './dom.ts';

const installedHostRequired = {
  en: 'Checkout requires the installed store host.',
  pl: 'Złożenie zamówienia wymaga uruchomienia zainstalowanego hosta sklepu.',
} satisfies LocaleCopy<string>;

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
  let rendered = false;
  let reviewPending = false;
  let previewOnly = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const copy = quoteCopy[context.locale];
  const base = () => ({ cart: context.getCart(), configuration: context.config.id, country: context.config.market.country,
    termsRevision: context.config.legal.revision, acquisitionCapability: ACQUISITION_TERMS_CAPABILITY });
  const binding = (input: ActionInput) => Object.fromEntries(Object.entries(input)
    .filter(([key]) => !['termsAccepted','quoteAcceptance','expectedTotal','locale'].includes(key))
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
  const values = () => ({ ...Object.fromEntries(new FormData(form).entries()), ...base() });
  const consent = () => form.querySelector<HTMLInputElement>('input[name="termsAccepted"]')!;
  function setPreviewOnly(active: boolean) {
    if (previewOnly === active) return;
    previewOnly = active;
    const consentField = consent().parentElement;
    if (consentField) consentField.hidden = active;
    form.querySelector('button[type="submit"]')?.setAttribute('aria-disabled', String(active));
  }
  function clear() {
    clearTimeout(expiry);
    current = undefined;
    rendered = false;
    reviewPending = false;
    consent().checked = false;
  }
  async function refresh(input: ActionInput) {
    const ownGeneration = ++generation;
    const review = binding(input);
    const scope = JSON.stringify(review);
    if (current && (current.binding !== scope || current.validUntil <= Date.now())) clear();
    const reviewed = consent().checked ? current : undefined;
    rendered = false;
    reviewPending = true;
    summary.replaceChildren(el('p', {}, copy.loading));
    const result = await act('offer.validate',review,crypto.randomUUID());
    if (ownGeneration !== generation) return false;
    reviewPending = false;
    if (!form.isConnected) { clear(); return false; }
    const quote = result.ok && isOfferQuoteView(result.value) ? result.value : undefined;
    if (!quote || quote.currency !== context.config.market.currency) {
      setPreviewOnly(false);
      clear();
      summary.replaceChildren(el('p', {},copy.unavailable),el('code', {},result.ok ? 'starter_quote_unavailable' : result.code));
      return false;
    }
    const next = observe(quote, scope);
    if (!next) {
      const estimate = quote.mode === 'one_time' && quote.expectedTotal === undefined
        && quote.quoteAcceptance === undefined && quote.acquisitionTerms === undefined;
      if (!previewOnly || !estimate) clear();
      setPreviewOnly(estimate);
      if (estimate) summary.replaceChildren(context.fragments.checkoutSummary(context,quote), el('p', {}, installedHostRequired[context.locale]));
      else summary.replaceChildren(el('p', {},copy.unavailable));
      return false;
    }
    setPreviewOnly(false);
    if (!reviewed || reviewed !== current || reviewed.terms !== next.terms ||
      reviewed.validUntil <= Date.now() || !consent().checked) {
      clear();
      current = next;
      if (Number.isFinite(next.validUntil)) expiry = setTimeout(() => {
        if (current !== next) return;
        clear();
        if (form.isConnected) summary.replaceChildren(el('p', {},copy.refresh));
      }, Math.max(0,next.validUntil - Date.now()));
    }
    summary.replaceChildren(context.fragments.checkoutSummary(context,quote));
    if (typeof quote.secondTotalMinor === 'number' && Number.isSafeInteger(quote.secondTotalMinor)) {
      summary.append(el('p', {},`${copy.second}: ${context.money(quote.secondTotalMinor)}`));
    }
    rendered = true;
    return true;
  }
  return { input: base,
    attach(element: HTMLElement) {
      if (form) clear();
      ++generation;
      const attached = form = element as HTMLFormElement;
      previewOnly = false;
      attached.addEventListener('change',event => {
        if (attached === form && (event.target as HTMLInputElement).name !== 'termsAccepted') void refresh(values());
      });
      queueMicrotask(() => { if (attached === form && form.isConnected) void refresh(values()); });
    },
    // A total refusal writes nothing, so the command keeps its key: a repeat under it cannot create a second order.
    refused(code: string) {
      const totalRefused = code === 'starter_expected_total_required' || code === 'starter_quote_price_changed';
      if (totalRefused || (code === 'starter_quote_refresh_required' && context.getCart().mode === 'one_time')) {
        ++generation;
        clear();
        void refresh(values());
      } else if (code === 'starter_quote_refresh_required' || code.startsWith('acquisition_terms_')) {
        ++generation; clear(); summary.replaceChildren(el('p', {},copy.refresh));
      }
    },
    async prepare(input: ActionInput): Promise<ActionInput | null> {
      if (previewOnly) return null;
      const matching = current?.binding === JSON.stringify(binding(input)) ? current : undefined;
      const reviewed = consent().checked ? matching : undefined;
      if (context.getCart().mode === 'one_time') {
        if (rendered && reviewed && form.isConnected) return { ...input, expectedTotal: reviewed.total };
        if (!matching && !reviewPending) await refresh(input);
        if (!previewOnly) summary.append(el('p', {}, copy.refresh));
        return null;
      }
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
