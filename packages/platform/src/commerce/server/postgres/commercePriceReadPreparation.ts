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
      [context.priceListId, context.regionCode, context.currency, context.channel], () => reads.listSubscriptionPolicyHistory(context))),
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

function prepareEntries(read: BulkRead) {
  const cache = new Map<string, Promise<Candidates>>();
  const waves = new Map<string, Map<string, { resolve(rows: Candidates): void; reject(error: unknown): void }>>();
  return (input: EntryInput): Promise<Candidates> => {
    const key = JSON.stringify([input.priceListId, input.variantId]);
    let pending = cache.get(key);
    if (!pending) {
      pending = new Promise<Candidates>((resolve, reject) => {
        let wave = waves.get(input.priceListId);
        if (!wave) {
          wave = new Map(); waves.set(input.priceListId, wave);
          queueMicrotask(() => { waves.delete(input.priceListId); void flush(input.priceListId, wave!); });
        }
        wave.set(input.variantId, { resolve, reject });
      });
      cache.set(key, pending);
    }
    return copy(pending);
  };
  async function flush(priceListId: string, wave: NonNullable<ReturnType<typeof waves.get>>) {
    try {
      const rows = await read({ priceListId, variantIds: [...wave.keys()] });
      const grouped = new Map<string, TimedAuthorityValue<ResolvedPrice>[]>();
      for (const row of rows) {
        const group = grouped.get(row.value.variantId) ?? [];
        group.push(row); grouped.set(row.value.variantId, group);
      }
      for (const [id, waiter] of wave) waiter.resolve(grouped.get(id) ?? []);
    } catch (error) { for (const waiter of wave.values()) waiter.reject(error); }
  }
}
