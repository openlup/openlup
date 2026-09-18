/** Persistent app device id shared by public pricing, live quote and checkout.
 *
 * ⛔ It must always exist in a browser. The server can only mint a signed offer
 * policy assignment that is *bound* to this id, so a request without one is
 * refused outright while `COMMERCE_OFFER_POLICY_V1_FALLBACK_DISABLED` is on —
 * i.e. the buyer sees no price at all. Returning `undefined` because storage is
 * denied (private windows, embedded webviews, blocked site data, a full quota)
 * therefore ends that buyer's checkout, so persistence degrades here instead:
 * localStorage, then sessionStorage, then this page session's memory. The
 * device first-order promotion guard treats an absent id as "no guard"
 * (`server/domains/commerce/promoDataPort.ts`), so a session-scoped id is
 * strictly more guard than the alternative it replaces, never less.
 */
export const VISITOR_ID_KEY = "openlup_vid";

type WebStorageKind = "localStorage" | "sessionStorage";

let sessionVisitorId: string | undefined;

export function getOrCreateVisitorId(): string | undefined {
  // Static rendering has no device to identify; the browser mints on hydration.
  if (typeof window === "undefined") return undefined;
  const persisted = readVisitorId("localStorage") ?? readVisitorId("sessionStorage");
  if (persisted) return persisted;
  sessionVisitorId ??= mintVisitorId();
  if (!writeVisitorId("localStorage", sessionVisitorId)) {
    writeVisitorId("sessionStorage", sessionVisitorId);
  }
  return sessionVisitorId;
}

/** Test-only: drop the in-memory fallback between storage scenarios. */
export function resetSessionVisitorIdForTests(): void {
  sessionVisitorId = undefined;
}

/** Every web-storage touch runs here: reading `window[kind]` throws on its own
 * in some privacy modes, and `setItem` throws on a full quota. */
function withStorage<T>(kind: WebStorageKind, use: (store: Storage) => T): T | undefined {
  try {
    const store = window[kind];
    return store ? use(store) : undefined;
  } catch {
    return undefined;
  }
}

function readVisitorId(kind: WebStorageKind): string | undefined {
  const value = withStorage(kind, (store) => store.getItem(VISITOR_ID_KEY));
  return value && value.trim() !== "" ? value : undefined;
}

function writeVisitorId(kind: WebStorageKind, value: string): boolean {
  return withStorage(kind, (store) => {
    store.setItem(VISITOR_ID_KEY, value);
    return true;
  }) ?? false;
}

function mintVisitorId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `vid-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
