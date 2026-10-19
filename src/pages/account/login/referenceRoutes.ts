import { normalizeCustomerReturnTo } from '@/domains/customers/contracts';

export function customerRoutes(language: string) {
  return language.startsWith('pl')
    ? { login: '/zaloguj-sie', callback: '/konto/auth/callback', account: '/konto' }
    : { login: '/sign-in', callback: '/account/auth/callback', account: '/account' };
}

/** The reference mounts only these account roots; broader account targets refuse. */
export function referenceAccountReturnTo(value: string | null, fallback: string): string {
  const path = normalizeCustomerReturnTo(value);
  return path === '/account' || path === '/konto' ? path : fallback;
}
