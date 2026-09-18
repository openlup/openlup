// Lightweight, NON-SENSITIVE "returning customer" hint for the login page.
//
// The login page (/zaloguj-sie) renders while the customer is logged OUT, so it
// cannot fetch the profile live. To personalise the returning experience (name,
// pet, prefilled e-mail, "last used" Google badge) we persist a tiny hint in
// localStorage after a successful login and read it back on the login page.
//
// Hard rule: NEVER store tokens or anything sensitive here — only display hints.
// All access is wrapped in try/catch (SSR, private mode, disabled storage, quota)
// and stale hints (older than MAX_AGE) are ignored.

const STORAGE_KEY = 'openlup-last-login';
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // ~60 days

export type CustomerLoginMethod = 'google' | 'email';

export type CustomerLoginHint = {
  firstName?: string | null;
  email?: string | null;
  petName?: string | null;
  method?: CustomerLoginMethod;
  /** ISO timestamp of the last write — used for TTL. */
  savedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isFresh(savedAt: string | undefined): boolean {
  if (!savedAt) return false;
  const ts = Date.parse(savedAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= MAX_AGE_MS;
}

/** Read the stored hint, or null when absent / stale / unparseable. */
export function readLoginHint(): CustomerLoginHint | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CustomerLoginHint> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isFresh(parsed.savedAt)) return null;
    return {
      firstName: parsed.firstName ?? null,
      email: parsed.email ?? null,
      petName: parsed.petName ?? null,
      method: parsed.method === 'google' || parsed.method === 'email' ? parsed.method : undefined,
      savedAt: parsed.savedAt as string,
    };
  } catch {
    return null;
  }
}

/**
 * Merge `patch` into the existing hint and persist it. The login method is
 * written at sign-in time; the name/pet/email are enriched after login. Merging
 * preserves whichever fields the other call already set.
 */
export function writeLoginHint(patch: Partial<Omit<CustomerLoginHint, 'savedAt'>>): void {
  try {
    const existing = readLoginHint();
    const next: CustomerLoginHint = {
      firstName: existing?.firstName ?? null,
      email: existing?.email ?? null,
      petName: existing?.petName ?? null,
      method: existing?.method,
      ...patch,
      savedAt: nowIso(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode / quota / SSR) — personalisation is a
    // progressive enhancement, so failing to persist is non-fatal.
  }
}

/** Forget the returning-customer hint (e.g. "sign in differently"). */
export function clearLoginHint(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
