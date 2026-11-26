import { isRecord } from '../shared/offer.ts';
import { resolveRoute } from '../shared/routes.ts';
import type { Locale } from '../shared/config.ts';
import { checkoutContinuationCopy } from '../shared/limits.ts';

interface Purchase { orderRef?: string; token?: string }
const memory = new Map<string, Purchase>();
const key = (configuration: string) => `neutral-store:purchase:v2:${configuration}`;
let entry: string | null = null;

/** Run synchronously at bootstrap and navigation, before rendering or query propagation. */
export function captureCompletionEntry(): void {
  if (resolveRoute(location.pathname).key !== 'completion') return;
  const query = new URLSearchParams(location.search);
  const token = query.get('token');
  if (token !== null) {
    entry = token;
    query.delete('token');
    history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
  }
}

/** Browser storage is a reload convenience. Only native inspection grants access. */
export function rememberPurchase(configuration: string, value: unknown): void {
  if (!isRecord(value)) return;
  let previous = memory.get(configuration);
  if (!previous) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key(configuration)) ?? 'null');
      if (isRecord(stored)) previous = {
        ...(typeof stored.orderRef === 'string' ? { orderRef: stored.orderRef } : {}),
        ...(typeof stored.token === 'string' ? { token: stored.token } : {}),
      };
    } catch { /* Missing storage never grants access. */ }
  }
  const purchase = { ...(typeof value.orderRef === 'string' ? { orderRef: value.orderRef } : {}),
    ...(typeof value.token === 'string' ? { token: value.token }
      : typeof value.orderRef === 'string' && value.orderRef === previous?.orderRef && previous.token
        ? { token: previous.token } : {}) };
  memory.set(configuration, purchase);
  try { sessionStorage.setItem(key(configuration), JSON.stringify(purchase)); } catch { /* Memory still serves this tab. */ }
}

export function currentPurchase(configuration: string): Purchase | null {
  if (entry !== null) {
    rememberPurchase(configuration, { token: entry });
    entry = null;
  }
  const active = memory.get(configuration);
  if (active) return active;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key(configuration)) ?? 'null');
    if (isRecord(value)) {
      rememberPurchase(configuration, value);
      return memory.get(configuration) ?? null;
    }
  } catch { /* Missing browser state never grants access. */ }
  return null;
}

export function visiblePurchase(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { token: _credential, ...visible } = value;
  return visible;
}

/** Forget the reload convenience when it is the given order; true when it was. */
export function forgetPurchase(configuration: string, orderRef: string): boolean {
  if (currentPurchase(configuration)?.orderRef !== orderRef) return false;
  memory.delete(configuration);
  try { sessionStorage.removeItem(key(configuration)); } catch { /* Memory no longer serves it. */ }
  return true;
}

export type CheckoutContinuationText = keyof typeof checkoutContinuationCopy;

/** A managed buyer text with its request-limit wait filled in. */
export function continuationMessage(text: CheckoutContinuationText, locale: Locale, windowMs: number): string {
  return checkoutContinuationCopy[text][locale].replaceAll('{minutes}', String(Math.ceil(windowMs / 60_000)));
}
