import type { CommercePromoDataPort } from "./promoDataPort.js";

/** Allocate inside one quote resolution; clone each evaluator's mutable raw view. */
export function memoizeCommercePromoReads(inner: CommercePromoDataPort): CommercePromoDataPort {
  const definitions = memoize(() => inner.listActivePromotions());
  const paid = memoize((id: string) => inner.countPaidOrders(id));
  const modes = memoize((id: string) => inner.countPaidOrdersByMode(id));
  const redemptions = memoize((id: string | null) => inner.redemptionCounts(id));
  const device = memoize((id: string | null) => inner.deviceFirstOrderRedeemed(id));
  return {
    listActivePromotions: async () => structuredClone(await definitions()),
    countPaidOrders: paid,
    countPaidOrdersByMode: async (id) => ({ ...await modes(id) }),
    redemptionCounts: async (id) => structuredClone(await redemptions(id)),
    deviceFirstOrderRedeemed: device,
  };
}
function memoize<A extends readonly unknown[], T>(read: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  const values = new Map<string, Promise<T>>();
  return (...args) => {
    const key = JSON.stringify(args);
    let value = values.get(key);
    if (!value) {
      value = Promise.resolve().then(() => read(...args));
      values.set(key, value);
    }
    return value;
  };
}
