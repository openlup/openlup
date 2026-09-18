import type { TFunction } from 'i18next';

import { formatCustomerOrderReference } from '@/lib/orderRef';
import { formatCurrencyMinor } from '@/lib/currency/formatMinor';
import { BffClientError } from '@/lib/bff/client';
import { stepForToken, trackingPhaseKeyForStep } from '@/domains/fulfillment/statusMap';

/** Generic "could not save" toast; the fallback whenever no specific reason is known. */
export const SUBSCRIPTION_ACTION_FALLBACK_TOAST_KEY = 'account:dashboard.saveFailed';

/**
 * The self-service RPC rejections worth an actionable toast. The server carries the
 * raw `customer_self_service_*` token in the BFF error's `details.reason`
 * (subscriptionActionErrorMapping.ts). Deliberately a SMALL fixed set: anything not
 * listed here is a bug or an internal guard, not customer-actionable copy.
 */
const SUBSCRIPTION_ACTION_ERROR_TOAST_KEYS: Readonly<Record<string, string>> = {
  customer_self_service_payment_blocked: 'account:dashboard.actionError.paymentBlocked',
  // Resume refuses while a charge for this subscription may still land, rather
  // than cancelling the unpaid cycle underneath the payer. Retrying in a few
  // minutes is the whole remedy, so it must not read as "add a payment method".
  customer_self_service_payment_blocked_attempt_in_flight:
    'account:dashboard.actionError.paymentInFlight',
  customer_self_service_invalid_transition: 'account:dashboard.actionError.invalidTransition',
  customer_self_service_edit_window_closed: 'account:dashboard.actionError.editWindowClosed',
};

/**
 * Picks the toast i18n key for a failed subscription self-service mutation. Total by
 * design: a non-BFF failure (network, thrown client code), a BFF error without
 * `details.reason`, and an unmapped reason all fall back to the long-standing generic
 * key, so a new RPC token can never render an untranslated string.
 */
export function subscriptionActionErrorToastKey(error: unknown): string {
  if (!(error instanceof BffClientError)) return SUBSCRIPTION_ACTION_FALLBACK_TOAST_KEY;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return SUBSCRIPTION_ACTION_FALLBACK_TOAST_KEY;
  const reason = (details as { reason?: unknown }).reason;
  if (typeof reason !== 'string') return SUBSCRIPTION_ACTION_FALLBACK_TOAST_KEY;
  return SUBSCRIPTION_ACTION_ERROR_TOAST_KEYS[reason] ?? SUBSCRIPTION_ACTION_FALLBACK_TOAST_KEY;
}

export function idempotencyKey(scope: string): string {
  return `${scope}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

/**
 * Turns a raw backend enum/identifier code (e.g. "fulfillment_pending",
 * "subscription.created") into a readable last-resort label by dropping the
 * domain prefix dot/underscores and capitalising. Used only as the fallback
 * when no i18n translation exists for the code — so an unmapped enum degrades
 * to "Fulfillment pending" instead of the raw machine string.
 */
export function humanizeCode(code: string): string {
  const spaced = code.replace(/[._]+/g, ' ').trim();
  if (!spaced) return code;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Translates a backend enum code through i18n, never surfacing the raw code to
 * the customer. `prefix` is the i18n namespace holding the code→label map
 * (e.g. "account:dashboard.panels.orders.orderStatus"); missing keys fall back
 * to `fallback` if given, otherwise to a humanized form of the code.
 */
export function enumLabel(
  t: TFunction,
  prefix: string,
  code: string | null | undefined,
  fallback?: string,
): string {
  if (!code) return fallback ?? '';
  return t(`${prefix}.${code}`, { defaultValue: fallback ?? humanizeCode(code) });
}

export function dateLabel(value: string | null, lang: 'pl' | 'en', fallback: string): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'pl-PL', { dateStyle: 'medium' }).format(new Date(value));
}

/**
 * Formats an amount the customer's account holds a **record** of, in that record's own
 * currency.
 *
 * It takes the money object rather than a bare `amountMinor` because all three callers
 * already have one and were unwrapping it a line before calling: an order total, an
 * issued invoice's gross, and a dunning arrears figure derived from one of those two.
 * Each arrives through a contract that validated its `currency` against
 * `platformCurrencySchema`, so the currency is present and checked - it was simply being
 * dropped and then re-asserted as a constant.
 *
 * This deliberately does NOT read the ambient settlement profile, which is what E2-F5
 * gave the storefront's *quoted* prices. Everything here is a past transaction, and a
 * past transaction's denomination cannot follow configuration: a deployment that changed
 * what it sells in would otherwise restate every historical order and invoice in the
 * customer's own account in a currency they never paid.
 */
export function money(amount: { amountMinor: number; currency: string }, lang: 'pl' | 'en'): string {
  return formatCurrencyMinor(amount.amountMinor, {
    currency: amount.currency,
    locale: lang === 'en' ? 'en-GB' : 'pl-PL',
  });
}

/**
 * Customer-facing order reference. Renders the SAME friendly reference the
 * customer sees in the confirmation email and on the thank-you page
 * (OPENLUP-XXXXXXXX) — one identifier across every touchpoint — never the raw
 * internal "order_<uuid>". Falls back to a bare label only when no ref is known.
 */
export function orderDisplayRef(
  order: { orderNumber?: string | null; orderRef?: string | null },
  t: TFunction,
): string {
  const ref = order.orderRef ?? '';
  if (ref) return formatCustomerOrderReference(ref);
  return t('account:dashboard.panels.orders.order');
}

/**
 * Buckets a raw fulfillment/tracking event type into a stable `trackingPhase.*`
 * i18n key so the start-page tile can be translated on the client.
 *
 * SOURCE OF TRUTH: config/fulfillment-status-map.json via statusMap.ts — the same
 * token→step mapping the orders card and order-detail timeline use, so this tile
 * can never drift from them. An unknown token falls to the generic `updated`.
 */
export function trackingPhaseKey(eventType: string | null | undefined): string {
  const step = stepForToken(eventType ?? null);
  return step ? trackingPhaseKeyForStep(step) : 'updated';
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(anchor.href);
}
