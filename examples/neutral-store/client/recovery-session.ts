import { resolveRoute } from '../shared/routes.ts';

const storageKey = 'neutral-store:subscription-recovery:v1';
let token: string | null = null;
/** Synchronous bootstrap: no configuration request or login bounce precedes this. */
export function captureRecoveryEntry(): void {
  if (resolveRoute(location.pathname).key !== 'repair') return;
  const query = new URLSearchParams(location.search);
  const value = query.get('token');
  if (value === null) return;
  token = /^(?:rcv_)?[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  try {
    if (token) sessionStorage.setItem(storageKey, token);
    else sessionStorage.removeItem(storageKey);
  } catch { /* This tab's memory still carries the credential. */ }
  query.delete('token');
  history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
}
export function currentRecoveryToken(): string | null {
  if (token) return token;
  try {
    const saved = sessionStorage.getItem(storageKey);
    return saved && /^(?:rcv_)?[A-Za-z0-9_-]{43}$/.test(saved) ? saved : null;
  } catch { return null; }
}
