import { isRecord } from '../shared/offer.ts';
import { resolveRoute } from '../shared/routes.ts';

interface Purchase { orderRef?: string; token?: string }
const memory = new Map<string, Purchase>();
const key = (configuration: string) => `neutral-store:purchase:v2:${configuration}`;
let entry: string | null = null;

/** Run synchronously before configuration fetch, rendering or query propagation. */
export function captureCompletionEntry(): void {
  if (resolveRoute(location.pathname).key !== 'completion') return;
  const query = new URLSearchParams(location.search);
  entry = query.get('token');
  if (entry !== null) {
    query.delete('token');
    history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + location.hash);
  }
}

/** Browser storage is a reload convenience. Only native inspection grants access. */
export function rememberPurchase(configuration: string, value: unknown): void {
  if (!isRecord(value)) return;
  const purchase = { ...(typeof value.orderRef === 'string' ? { orderRef: value.orderRef } : {}),
    ...(typeof value.token === 'string' ? { token: value.token } : {}) };
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
