import { createHash } from 'node:crypto';
import type { NativeCheckoutQuery } from '@openlup/platform/commerce/server/native-checkout';
import { isRecord } from '../shared/offer.ts';
import type { StoreConfig } from '../shared/config.ts';

type Settings = StoreConfig['purchase']['attemptLimits'];
export type CheckoutRateLimit = (request: { headers: Record<string, string | string[] | undefined>; requesterKey?: string },
  intent: { idempotencyKey: string; contact: { email: string } }, sequence: number | undefined) => Promise<{ allowed: boolean; reason?: 'email_quota' | 'ip_quota' }>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = (value: string) => /^[0-9a-f]{64}$/.test(value);

/** The caller supplies the held checkout session before opening the draft transaction. */
export function createPostgresCheckoutRateLimit(db: NativeCheckoutQuery, settings: Settings): CheckoutRateLimit {
  return async (request, intent, sequence = 0) => {
    try {
      const { requesterKey } = request;
      const { idempotencyKey, contact } = intent;
      const email = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
      const { windowMs, retentionMs, maxPerEmail, maxPerRequester, maxEntries } = settings;
      const policy = [windowMs, retentionMs, maxPerEmail, maxPerRequester, maxEntries];
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || !email
        || typeof requesterKey !== 'string' || !hex(requesterKey)
        || !Number.isSafeInteger(sequence) || sequence < 0
        || policy.some(value => !Number.isSafeInteger(value) || value < 1)
        || retentionMs < windowMs) return { allowed: false };

      const { rows } = await db.query(
        'SELECT public.commerce_record_checkout_attempt($1::text,$2::text,$3::text,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint) AS result',
        [hash(`${idempotencyKey}\0${sequence}`), requesterKey, hash(email), ...policy]);
      if (!Array.isArray(rows) || rows.length !== 1) return { allowed: false };
      const result = rows[0]?.result;
      if (isRecord(result) && Object.hasOwn(result, 'allowed')) {
        const keys = Object.keys(result);
        if (keys.length === 1 && result.allowed === true) return { allowed: true };
        if (keys.length === 2 && Object.hasOwn(result, 'reason') && result.allowed === false
          && (result.reason === 'email_quota' || result.reason === 'ip_quota')) {
          return { allowed: false, reason: result.reason };
        }
      }
    } catch { /* Admission fails closed without exposing database or request details. */ }
    return { allowed: false };
  };
}

/** A thrown or malformed replacement callback cannot turn into admission. */
export async function admitCheckoutAttempt(check: CheckoutRateLimit, ...input: Parameters<CheckoutRateLimit>) {
  try {
    const result = await check(...input);
    return result?.allowed === true && result.reason === undefined
      && Object.keys(result).every(key => key === 'allowed' || key === 'reason');
  } catch { return false; }
}

/** Host identity binding remains in force when the quota callback is replaced.
 * Binding and capacity checks are synchronous; only identity digests are kept. */
export function createCheckoutAttemptBindings(settings: Settings, now: () => number = Date.now) {
  type Entry = { identity: string; at: number };
  const entries = new Map<string, Entry>();
  const identityDigest = (email: string, requesterKey: string | undefined) =>
    hash(JSON.stringify([email.trim().toLowerCase(), requesterKey]));
  return {
    conflicts(commandKey: string, email: string, requesterKey: string | undefined): boolean {
      const existing = entries.get(hash(commandKey));
      return existing !== undefined && existing.at > now() - settings.retentionMs
        && existing.identity !== identityDigest(email, requesterKey);
    },
    bind(commandKey: string, email: string, requesterKey: string | undefined): Entry | null {
      const at = now();
      if (!Number.isFinite(at) || !commandKey || !email.trim() || !requesterKey || !hex(requesterKey)
        || Object.values(settings).some(value => !Number.isSafeInteger(value) || value < 1)
        || settings.retentionMs < settings.windowMs) return null;
      for (const [key, entry] of entries) if (entry.at <= at - settings.retentionMs) entries.delete(key);
      const key = hash(commandKey);
      const identity = identityDigest(email, requesterKey);
      const existing = entries.get(key);
      if (existing) return existing.identity === identity ? existing : null;
      if (entries.size >= settings.maxEntries) return null;
      const entry: Entry = { identity, at };
      entries.set(key, entry);
      return entry;
    },
  };
}
