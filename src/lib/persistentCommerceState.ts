/**
 * Generic, SSR-safe localStorage codec for persisting commerce form state
 * across page reloads. Mirrors the safe-storage idiom in
 * `pages/skomponuj-pakiet/lib/checkoutAttemptStore.ts` (window guard, try/catch,
 * versioned `openlup:…:v1` key) and adds a TTL so stale state self-expires.
 *
 * NOTE: callers may persist personal data (e.g. checkout shipping fields). The
 * envelope carries a TTL and callers are expected to `clear()` on order success
 * so the local copy does not outlive its purpose.
 */

interface Envelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

export interface PersistedState<T> {
  load(): T | null;
  loadResult(): PersistedLoadResult<T>;
  save(data: T): PersistedWriteStatus;
  clear(): PersistedClearStatus;
}

export type PersistedWriteStatus =
  | "saved"
  | "unchanged"
  | "disabled"
  | "unavailable"
  | "quota";

export type PersistedClearStatus = "cleared" | "disabled" | "unavailable";

export type PersistedLoadStatus =
  | "loaded"
  | "missing"
  | "disabled"
  | "unavailable"
  | "invalid"
  | "expired";

export interface PersistedLoadResult<T> {
  status: PersistedLoadStatus;
  data: T | null;
  savedAt: number | null;
}

export interface PersistedStateConfig<T> {
  /** Versioned storage key, e.g. `openlup:configurator:v1`. */
  key: string;
  /** Schema version; a mismatch on load drops the stored value. */
  version: number;
  /** Max age in ms before a stored value is considered stale and dropped. */
  ttlMs: number;
  /** Optional transform applied before writing (e.g. strip honeypot fields). */
  sanitize?: (data: T) => T;
  /**
   * Optional shape guard applied on load. When it returns false the stored
   * value is dropped (treated like a version mismatch). This makes deploys
   * neutral across incompatible shape drift: a restored payload that no longer
   * matches the current type self-heals to a fresh state instead of feeding
   * malformed data into the UI.
   */
  validate?: (data: T) => boolean;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createPersistedState<T>({
  key,
  version,
  ttlMs,
  sanitize,
  validate,
}: PersistedStateConfig<T>): PersistedState<T> {
  let lastWrittenDataRaw: string | null = null;

  function clear(): PersistedClearStatus {
    const storage = getLocalStorage();
    if (!storage) return "unavailable";
    try {
      storage.removeItem(key);
      lastWrittenDataRaw = null;
      return "cleared";
    } catch {
      return "unavailable";
    }
  }

  function loadResult(): PersistedLoadResult<T> {
    const storage = getLocalStorage();
    if (!storage) return { status: "unavailable", data: null, savedAt: null };

    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return { status: "unavailable", data: null, savedAt: null };
    }
    if (!raw) return { status: "missing", data: null, savedAt: null };

    try {
      const parsed = JSON.parse(raw) as Partial<Envelope<T>>;
      const structurallyValid =
        parsed?.v === version && typeof parsed.savedAt === "number" && "data" in parsed;
      if (!structurallyValid) {
        clear();
        return { status: "invalid", data: null, savedAt: null };
      }
      if (Date.now() - parsed.savedAt! > ttlMs) {
        clear();
        return { status: "expired", data: null, savedAt: parsed.savedAt! };
      }
      const data = parsed.data as T;
      if (validate && !validate(data)) {
        clear();
        return { status: "invalid", data: null, savedAt: parsed.savedAt! };
      }
      lastWrittenDataRaw = JSON.stringify(data);
      return { status: "loaded", data, savedAt: parsed.savedAt! };
    } catch {
      clear();
      return { status: "invalid", data: null, savedAt: null };
    }
  }

  function load(): T | null {
    return loadResult().data;
  }

  function save(data: T): PersistedWriteStatus {
    const storage = getLocalStorage();
    if (!storage) return "unavailable";
    const envelope: Envelope<T> = {
      v: version,
      savedAt: Date.now(),
      data: sanitize ? sanitize(data) : data,
    };
    try {
      const dataRaw = JSON.stringify(envelope.data);
      if (dataRaw === lastWrittenDataRaw) return "unchanged";
      const raw = JSON.stringify(envelope);
      storage.setItem(key, raw);
      lastWrittenDataRaw = dataRaw;
      return "saved";
    } catch (error) {
      return error instanceof DOMException && error.name === "QuotaExceededError"
        ? "quota"
        : "unavailable";
    }
  }

  return { load, loadResult, save, clear };
}
