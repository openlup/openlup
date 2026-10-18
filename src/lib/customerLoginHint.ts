import { readStorageItem, writeStorageItem, removeStorageItem } from './browserStorage';

const STORAGE_KEY = 'customer.login.hint.v1';
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
export type CustomerLoginMethod = 'email' | 'social';
export type CustomerLoginHint = { method: CustomerLoginMethod; savedAt: string };

export function readLoginHint(): CustomerLoginHint | null {
  try {
    const value = JSON.parse(readStorageItem('localStorage', STORAGE_KEY) ?? 'null');
    const age = Date.now() - Date.parse(value?.savedAt);
    if (!['email', 'social'].includes(value?.method) || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return null;
    return { method: value.method, savedAt: value.savedAt };
  } catch { return null; }
}
export function writeLoginHint({ method }: { method: CustomerLoginMethod }): void {
  writeStorageItem('localStorage', STORAGE_KEY, JSON.stringify({ method, savedAt: new Date().toISOString() }));
}
export function clearLoginHint(): void { removeStorageItem('localStorage', STORAGE_KEY); }
