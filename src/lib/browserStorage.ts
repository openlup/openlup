/**
 * The single boundary for web-storage access on the client tree.
 *
 * In an in-app webview configured to deny site data — a large and commercially
 * relevant slice of storefront traffic — reading `window.localStorage` ITSELF
 * throws `SecurityError`. The throw lands on the property access, before any
 * `getItem` call a `try` around the method could wrap, so a guard placed around
 * the call is not a guard at all. Reaching for the bare `localStorage` /
 * `sessionStorage` global is therefore never safe on this tree, not even to
 * hand it to a library that only wants somewhere to keep a session.
 *
 * That distinction is why this is worth a boundary rather than another local
 * `try`. An unguarded reach inside a React effect is not a degraded feature: it
 * escapes the effect, reaches `RouteErrorBoundary`, and replaces the WHOLE page
 * with the crash card — on every route the component renders on, which for a
 * header-level effect is every route the site has.
 *
 * Storage denial is a supported browsing mode, not an error. Every helper here
 * degrades: a read yields `null`, a write reports `false`, and a caller that
 * cannot accept the absence of a store gets a tab-lifetime memory one.
 */

export type BrowserStorageName = "localStorage" | "sessionStorage";

/**
 * The real store, or `null` when the browser refuses to hand it over.
 *
 * Never cache the returned object across a page's lifetime as a substitute for
 * calling this again: a store can be handed over and still reject every write.
 */
export function getBrowserStorage(name: BrowserStorageName): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[name] ?? null;
  } catch {
    return null;
  }
}

/** Read one key, or `null` when it is absent or storage is denied. */
export function readStorageItem(name: BrowserStorageName, key: string): string | null {
  const storage = getBrowserStorage(name);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Write one key. Returns whether the value was actually persisted. */
export function writeStorageItem(
  name: BrowserStorageName,
  key: string,
  value: string,
): boolean {
  const storage = getBrowserStorage(name);
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    // Denied store, quota exhausted, or a private mode with a zero-byte budget.
    return false;
  }
}

/** Remove one key. Best effort: a denied store has nothing to remove. */
export function removeStorageItem(name: BrowserStorageName, key: string): void {
  const storage = getBrowserStorage(name);
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Best effort; the value is unreachable either way.
  }
}

/** A `Storage`-shaped store that lives in this document and nowhere else. */
export function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value));
    },
  } satisfies Storage;
}

const memoryStores = new Map<BrowserStorageName, Storage>();

/**
 * A store that always exists, for callers that cannot take `null` — the auth
 * clients take a `Storage` at construction and have nowhere to put a refusal.
 *
 * When the browser denies the real store the session moves to a memory one and
 * therefore lives for this document instead of for the device. That is the
 * degradation a visitor who blocked site data asked for; the alternative on
 * this tree is a thrown constructor and a blank page.
 *
 * The memory store is created once per name so two calls in one document share
 * a session, exactly as two reads of the real store would.
 */
export function resolveStorageOrMemory(name: BrowserStorageName): Storage {
  const storage = getBrowserStorage(name);
  if (storage) return storage;
  const existing = memoryStores.get(name);
  if (existing) return existing;
  const fallback = createMemoryStorage();
  memoryStores.set(name, fallback);
  return fallback;
}
