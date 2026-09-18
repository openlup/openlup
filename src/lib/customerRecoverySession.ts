import { normalizeCustomerReturnTo } from '@/domains/customers/contracts';
import { routeMap } from '@/lib/i18nRoutes';

export const CUSTOMER_RETURN_TO_STORAGE_KEY = 'openlup:customer-return-to';
export const PAYMENT_RECOVERY_TOKEN_STORAGE_KEY = 'openlup:payment-recovery-token';
export const PAYMENT_RECOVERY_METHOD_REF_STORAGE_KEY = 'openlup:payment-recovery-method-ref';
export const PAYMENT_RECOVERY_METHOD_KIND_STORAGE_KEY = 'openlup:payment-recovery-method-kind';
export const PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY = 'openlup:payment-recovery-token-cross-tab:v1';
export const PAYMENT_RECOVERY_COOKIE_NAME = 'openlup_payment_recovery_token_v1';

const PAYMENT_RECOVERY_CROSS_TAB_TTL_MS = 20 * 60 * 1000;
let paymentRecoveryTokenInMemory: string | null = null;

// The concrete recovery route is app/overlay-owned market config: source it from
// the single canonical route registry (routeMap.customerPaymentRecovery) instead
// of re-inlining the localized literal. Byte-identical to the previous values.
export const PAYMENT_RECOVERY_PATH = routeMap.customerPaymentRecovery.pl ?? routeMap.customerPaymentRecovery.en;
export const PAYMENT_RECOVERY_PATH_EN = routeMap.customerPaymentRecovery.en;

type BrowserStorageName = 'sessionStorage' | 'localStorage';

export function saveCustomerReturnTo(path: string): void {
  const safePath = normalizeCustomerReturnTo(path);
  if (!safePath) return;
  setStorageValue('sessionStorage', CUSTOMER_RETURN_TO_STORAGE_KEY, safePath);
}

export function readCustomerReturnTo(): string | null {
  if (typeof window !== 'undefined') {
    const queryValue = new URLSearchParams(window.location.search).get('returnTo');
    const queryPath = normalizeCustomerReturnTo(queryValue);
    if (queryPath) return queryPath;
  }
  const value = getStorageValue('sessionStorage', CUSTOMER_RETURN_TO_STORAGE_KEY);
  return normalizeCustomerReturnTo(value);
}

export function consumeCustomerReturnTo(preferredPath?: string | null): string | null {
  const value = normalizeCustomerReturnTo(preferredPath) ?? readCustomerReturnTo();
  removeStorageValue('sessionStorage', CUSTOMER_RETURN_TO_STORAGE_KEY);
  return value;
}

export function savePaymentRecoveryToken(token: string): void {
  persistPaymentRecoveryToken(token);
}

function persistPaymentRecoveryToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  paymentRecoveryTokenInMemory = trimmed;
  const sessionSaved = setStorageValue('sessionStorage', PAYMENT_RECOVERY_TOKEN_STORAGE_KEY, trimmed);
  const localSaved = setStorageValue('localStorage', PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY, JSON.stringify({
    token: trimmed,
    expiresAt: Date.now() + PAYMENT_RECOVERY_CROSS_TAB_TTL_MS,
  }));
  const cookieSaved = !sessionSaved && !localSaved && setPaymentRecoveryCookie(trimmed);
  return sessionSaved || localSaved || cookieSaved || paymentRecoveryTokenInMemory === trimmed;
}

export function readPaymentRecoveryToken(): string | null {
  if (typeof window !== 'undefined') {
    const urlToken = new URLSearchParams(window.location.search).get('token')?.trim();
    if (urlToken) return urlToken;
  }
  const value = getStorageValue('sessionStorage', PAYMENT_RECOVERY_TOKEN_STORAGE_KEY)?.trim() ?? '';
  if (value) return value;

  const crossTabValue = getStorageValue('localStorage', PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY);
  if (crossTabValue) {
    try {
      const parsed = JSON.parse(crossTabValue) as { token?: unknown; expiresAt?: unknown };
      if (
        typeof parsed.token !== 'string' ||
        !parsed.token.trim() ||
        typeof parsed.expiresAt !== 'number' ||
        parsed.expiresAt <= Date.now()
      ) {
        removeStorageValue('localStorage', PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY);
      } else {
        if (setStorageValue('sessionStorage', PAYMENT_RECOVERY_TOKEN_STORAGE_KEY, parsed.token.trim())) {
          removeStorageValue('localStorage', PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY);
        }
        return parsed.token.trim();
      }
    } catch {
      removeStorageValue('localStorage', PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY);
    }
  }

  const cookieToken = readPaymentRecoveryCookie();
  if (cookieToken && setStorageValue('sessionStorage', PAYMENT_RECOVERY_TOKEN_STORAGE_KEY, cookieToken)) {
    clearPaymentRecoveryCookies();
  }
  return cookieToken ?? paymentRecoveryTokenInMemory;
}

export function savePaymentRecoveryMethodEvidence(methodRef: string, methodKind: string): void {
  const trimmedRef = methodRef.trim();
  const trimmedKind = methodKind.trim();
  if (!trimmedRef || !trimmedKind) return;
  setStorageValue('sessionStorage', PAYMENT_RECOVERY_METHOD_REF_STORAGE_KEY, trimmedRef);
  setStorageValue('sessionStorage', PAYMENT_RECOVERY_METHOD_KIND_STORAGE_KEY, trimmedKind);
}

export function readPaymentRecoveryMethodEvidence(): {
  paymentMethodRef: string;
  paymentMethodKind: string;
} | null {
  const paymentMethodRef = getStorageValue('sessionStorage', PAYMENT_RECOVERY_METHOD_REF_STORAGE_KEY)?.trim() ?? '';
  const paymentMethodKind = getStorageValue('sessionStorage', PAYMENT_RECOVERY_METHOD_KIND_STORAGE_KEY)?.trim() ?? '';
  return paymentMethodRef && paymentMethodKind ? { paymentMethodRef, paymentMethodKind } : null;
}

export function clearPaymentRecoverySession(): void {
  paymentRecoveryTokenInMemory = null;
  removeStorageValue('sessionStorage', PAYMENT_RECOVERY_TOKEN_STORAGE_KEY);
  removeStorageValue('sessionStorage', PAYMENT_RECOVERY_METHOD_REF_STORAGE_KEY);
  removeStorageValue('sessionStorage', PAYMENT_RECOVERY_METHOD_KIND_STORAGE_KEY);
  removeStorageValue('localStorage', PAYMENT_RECOVERY_CROSS_TAB_STORAGE_KEY);
  clearPaymentRecoveryCookies();
}

export function capturePaymentRecoveryTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;

  const url = new URL(window.location.href);
  const token = url.searchParams.get('token')?.trim() ?? '';
  const tokenSaved = token ? persistPaymentRecoveryToken(token) : false;

  if (tokenSaved) {
    url.searchParams.delete('token');
    const nextSearch = url.searchParams.toString();
    const cleanUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
    window.history.replaceState(null, '', cleanUrl);
    return cleanUrl;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function getStorageValue(storageName: BrowserStorageName, key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[storageName].getItem(key);
  } catch {
    return null;
  }
}

function setStorageValue(storageName: BrowserStorageName, key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window[storageName].setItem(key, value);
    return true;
  } catch {
    // Recovery remains usable where the browser still permits storage.
    return false;
  }
}

function removeStorageValue(storageName: BrowserStorageName, key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window[storageName].removeItem(key);
  } catch {
    // Best-effort expiry and cleanup for restricted storage modes.
  }
}

function setPaymentRecoveryCookie(token: string): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${PAYMENT_RECOVERY_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${PAYMENT_RECOVERY_CROSS_TAB_TTL_MS / 1000}; Path=${paymentRecoveryCookiePath()}; SameSite=Strict${secure}`;
    return readPaymentRecoveryCookie() === token;
  } catch {
    return false;
  }
}

function readPaymentRecoveryCookie(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const prefix = `${PAYMENT_RECOVERY_COOKIE_NAME}=`;
    const value = document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix))?.slice(prefix.length);
    return value ? decodeURIComponent(value).trim() || null : null;
  } catch {
    return null;
  }
}

function paymentRecoveryCookiePath(): string {
  if (typeof window === 'undefined') return PAYMENT_RECOVERY_PATH;
  return window.location.pathname === PAYMENT_RECOVERY_PATH_EN
    ? PAYMENT_RECOVERY_PATH_EN
    : PAYMENT_RECOVERY_PATH;
}

function clearPaymentRecoveryCookies(): void {
  if (typeof document === 'undefined') return;
  for (const path of [PAYMENT_RECOVERY_PATH, PAYMENT_RECOVERY_PATH_EN]) {
    try {
      document.cookie = `${PAYMENT_RECOVERY_COOKIE_NAME}=; Max-Age=0; Path=${path}; SameSite=Strict`;
    } catch {
      // Best-effort expiry for restricted cookie modes.
    }
  }
}
