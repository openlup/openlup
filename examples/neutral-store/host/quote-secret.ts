import { readFile } from 'node:fs/promises';
import type { PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import { isRecord } from '../shared/offer.ts';

/** The host receives an existing private keyring file; this function provisions nothing. */
export async function readQuoteAcceptanceKeyring(path: string): Promise<PromotionAcceptanceKeyring> {
  const bytes = await readFile(path);
  if (bytes.length > 8192) throw new Error('starter_quote_acceptance_key_invalid');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'current' && key !== 'previous')
    || typeof value.current !== 'string' || value.current.length < 32
    || (value.previous !== undefined && value.previous !== null && (typeof value.previous !== 'string' || value.previous.length < 32))) {
    throw new Error('starter_quote_acceptance_key_invalid');
  }
  return { current: value.current, ...(typeof value.previous === 'string' ? { previous: value.previous } : {}) };
}
