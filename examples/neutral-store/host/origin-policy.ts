import type { StoreConfig } from '../shared/config.ts';

export interface OriginPolicy {
  originFor(authority: string): string | null;
  secureCookies: boolean;
}

/** Input has passed assertConfig. Forwarded headers are deliberately not inputs. */
export function createOriginPolicy(config: Pick<StoreConfig, 'publicOrigin'>, port: number): OriginPolicy {
  const configured = config.publicOrigin === undefined ? null : new URL(config.publicOrigin);
  const authorities = configured ? [configured.host] : [`127.0.0.1:${port}`, `localhost:${port}`];
  return {
    originFor: authority => authorities.includes(authority) ? configured?.origin ?? `http://${authority}` : null,
    secureCookies: configured?.protocol === 'https:',
  };
}

function singleHeader(rawHeaders: readonly string[], name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? '');
  }
  return values.length === 1 && values[0] && !values[0].includes(',') ? values[0] : null;
}

/** Reject duplicates before Node's normalized headers can discard a value. */
export function admitRequest(policy: OriginPolicy, method: string, rawHeaders: readonly string[]):
  { ok: true; origin: string } | { ok: false; code: string } {
  const host = singleHeader(rawHeaders, 'host');
  const origin = host === null ? null : policy.originFor(host);
  if (origin === null) return { ok: false, code: 'starter_local_host_required' };
  // Duplicate/multi-valued Origin is ambiguous even on a read.
  const originCount = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'origin').length;
  const suppliedOrigin = singleHeader(rawHeaders, 'origin');
  if (originCount && suppliedOrigin === null) return { ok: false, code: 'starter_same_origin_required' };
  if (method !== 'GET' && method !== 'HEAD') {
    if (suppliedOrigin !== origin || singleHeader(rawHeaders, 'x-starter-request') !== '1'
      || singleHeader(rawHeaders, 'content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return { ok: false, code: 'starter_same_origin_required' };
    }
  }
  return { ok: true, origin };
}
