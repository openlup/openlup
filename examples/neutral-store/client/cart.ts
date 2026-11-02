import type { StoreConfig } from '../shared/config.ts';
import { emptyCart, evaluateOffer, type Cart } from '../shared/offer.ts';

export interface BrowserCart {
  get(): Cart;
  set(cart: Cart): void;
  clear(): void;
  close(): void;
}

export function createBrowserCart(config: StoreConfig, notice: (kind: 'storageUnavailable' | 'cartReset' | 'storageChanged') => void): BrowserCart {
  const key = `neutral-store:cart:v1:${config.id}`;
  let current = emptyCart(config);
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { notice('storageUnavailable'); }

  function read(raw: string | null): Cart {
    if (raw === null) return emptyCart(config);
    try {
      const result = evaluateOffer(config, JSON.parse(raw));
      if (result.ok) return result.cart;
      if (result.selection) return result.selection;
      // An empty saved cart is valid application state, although it cannot be checked out.
      const candidate: unknown = JSON.parse(raw);
      if (typeof candidate === 'object' && candidate !== null
        && 'configuration' in candidate && candidate.configuration === config.id
        && 'lines' in candidate && Array.isArray(candidate.lines) && candidate.lines.length === 0) {
        return emptyCart(config);
      }
    } catch { /* Damaged browser data never becomes checkout input. */ }
    notice('cartReset');
    return emptyCart(config);
  }

  try { current = read(storage?.getItem(key) ?? null); }
  catch { storage = null; notice('storageUnavailable'); }

  function changed(event: StorageEvent): void {
    if (event.key !== key || event.storageArea !== storage) return;
    current = read(event.newValue);
    notice('storageChanged');
  }
  window.addEventListener('storage', changed);

  return {
    get: () => structuredClone(current),
    set(cart) {
      current = structuredClone(cart);
      try { storage?.setItem(key, JSON.stringify(current)); }
      catch { storage = null; notice('storageUnavailable'); }
    },
    clear() {
      current = emptyCart(config);
      try { storage?.removeItem(key); }
      catch { storage = null; notice('storageUnavailable'); }
    },
    close: () => window.removeEventListener('storage', changed),
  };
}
