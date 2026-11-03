import { createHash } from 'node:crypto';
import type { StoreConfig } from '../shared/config.ts';

type Settings = StoreConfig['purchase']['attemptLimits'];
export type CheckoutRateLimit = (request: { headers: Record<string, string | string[] | undefined>; requesterKey?: string },
  intent: { idempotencyKey: string; contact: { email: string } }, sequence: number | undefined) => Promise<{ allowed: boolean; reason?: 'email_quota' | 'ip_quota' }>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = (value: string) => /^[0-9a-f]{64}$/.test(value);

/** Interim implementation of the checkout admission callback; replace with the durable port.
 * Only digests/numbers survive the call. One synchronous critical section serializes this process. */
export function createInterimCheckoutLimiter(settings: Settings, now: () => number = Date.now) {
  const attempts = new Map<string, { requester: string; email: string; at: number }>();
  const checkRateLimit: CheckoutRateLimit = async (request, intent, sequence = 0) => {
    try {
      const at = now();
      if (!Number.isFinite(at) || !request.requesterKey || !hex(request.requesterKey)
        || !intent.idempotencyKey || !intent.contact.email.trim() || !Number.isSafeInteger(sequence) || sequence < 0
        || Object.values(settings).some(value => !Number.isSafeInteger(value) || value < 1)
        || settings.retentionMs < settings.windowMs) return { allowed: false };
      for (const [key, value] of attempts) {
        if (!hex(key) || !hex(value.email) || !hex(value.requester) || !Number.isFinite(value.at)) return { allowed: false };
        if (value.at <= at - settings.retentionMs) attempts.delete(key);
      }
      const exact = hash(`${intent.idempotencyKey}\0${sequence}`);
      const existing = attempts.get(exact);
      if (existing) return { allowed: true };
      const email = hash(intent.contact.email.trim().toLowerCase());
      let emails = 0, requesters = 0;
      for (const value of attempts.values()) if (value.at > at - settings.windowMs) {
        if (value.email === email) emails++;
        if (value.requester === request.requesterKey) requesters++;
      }
      if (emails >= settings.maxPerEmail) return { allowed: false, reason: 'email_quota' };
      if (requesters >= settings.maxPerRequester) return { allowed: false, reason: 'ip_quota' };
      if (!existing && attempts.size >= settings.maxEntries) return { allowed: false };
      attempts.set(exact, { requester: request.requesterKey, email, at });
      return { allowed: true };
    } catch { return { allowed: false }; }
  };
  return { checkRateLimit,
    // Private diagnostics contain the exact stored representation, never request inputs.
    snapshot: () => [...attempts.entries()].map(([key, value]) => ({ key, ...value })) };
}

/** A thrown or malformed replacement callback cannot turn into admission. */
export async function admitCheckoutAttempt(check: CheckoutRateLimit, ...input: Parameters<CheckoutRateLimit>) {
  try {
    const result = await check(...input);
    return result?.allowed === true && result.reason === undefined
      && Object.keys(result).every(key => key === 'allowed' || key === 'reason');
  } catch { return false; }
}
