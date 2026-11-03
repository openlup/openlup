import type { CommercePriceAuthorityReadPort, TimedAuthorityValue } from "../../../pricing/index.js";
import type { ResolvedPrice } from "@openlup/core/pricing";

type Candidates = ReadonlyArray<TimedAuthorityValue<ResolvedPrice>>;
type EntryInput = Parameters<CommercePriceAuthorityReadPort["listExactBaseEntries"]>[0];
type BulkRead = (input: { variantIds: readonly string[]; priceListId: string }) => Promise<Candidates>;
interface BulkReads extends CommercePriceAuthorityReadPort {
  listExactBaseEntriesBulk: BulkRead;
  listExactLegacySubscriptionEntriesBulk: BulkRead;
}

/** Internal request scope, including failed reads and caller-owned mutable views. */
export function prepareCommercePriceReads(reads: BulkReads): CommercePriceAuthorityReadPort {
  const lists = new Map<string, Promise<ReadonlyArray<TimedAuthorityValue<string>>>>();
  const policies = new Map<string, Promise<ReadonlyArray<TimedAuthorityValue<unknown>>>>();
  return {
    listPriceLists: context => copy(memo(lists, [context.regionCode, context.currency], () => reads.listPriceLists(context))),
    listSubscriptionPolicyHistory: context => copy(memo(policies,
      [canonicalUuidKey(context.priceListId), context.regionCode, context.currency, context.channel], () => reads.listSubscriptionPolicyHistory(context))),
    listExactBaseEntries: prepareEntries(reads.listExactBaseEntriesBulk.bind(reads)),
    listExactLegacySubscriptionEntries: prepareEntries(reads.listExactLegacySubscriptionEntriesBulk.bind(reads)),
  };
}
function memo<T>(cache: Map<string, Promise<T>>, identity: readonly string[], read: () => Promise<T>): Promise<T> {
  const key = JSON.stringify(identity);
  let pending = cache.get(key);
  if (!pending) { pending = Promise.resolve().then(read); cache.set(key, pending); }
  return pending;
}
async function copy<T>(pending: Promise<T>): Promise<T> { return structuredClone(await pending); }

// PostgreSQL accepts optional braces and hyphens after groups of four hex digits.
// Normalize identity keys only; invalid inputs still reach the existing SQL cast.
function canonicalUuidKey(value: string): string {
  const body = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  if (/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.exec(body)?.[0] !== body) return value;
  const hex = body.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function prepareEntries(read: BulkRead) {
  const cache = new Map<string, Promise<Candidates>>();
  const waves = new Map<string, Map<string, { variantId: string; resolve(rows: Candidates): void; reject(error: unknown): void }>>();
  return (input: EntryInput): Promise<Candidates> => {
    const priceListKey = canonicalUuidKey(input.priceListId), variantKey = canonicalUuidKey(input.variantId);
    const key = JSON.stringify([priceListKey, variantKey]);
    let pending = cache.get(key);
    if (!pending) {
      pending = new Promise<Candidates>((resolve, reject) => {
        let wave = waves.get(priceListKey);
        if (!wave) {
          wave = new Map(); waves.set(priceListKey, wave);
          queueMicrotask(() => { waves.delete(priceListKey); void flush(input.priceListId, wave!); });
        }
        wave.set(variantKey, { variantId: input.variantId, resolve, reject });
      });
      cache.set(key, pending);
    }
    return copy(pending);
  };
  async function flush(priceListId: string, wave: NonNullable<ReturnType<typeof waves.get>>) {
    try {
      const rows = await read({ priceListId, variantIds: [...wave.values()].map(waiter => waiter.variantId) });
      const grouped = new Map<string, TimedAuthorityValue<ResolvedPrice>[]>();
      for (const row of rows) {
        const id = canonicalUuidKey(row.value.variantId);
        const group = grouped.get(id) ?? [];
        group.push(row); grouped.set(id, group);
      }
      for (const [id, waiter] of wave) waiter.resolve(grouped.get(id) ?? []);
    } catch (error) { for (const waiter of wave.values()) waiter.reject(error); }
  }
}
