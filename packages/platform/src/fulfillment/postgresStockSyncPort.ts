import { createHash } from 'node:crypto';
import type { FulfillmentStockSyncPort, SyncCursor } from './contracts/index.js';
import { nativeCall, type PgExecutor } from './postgresDispatchStore.js';

/** The native catalogue has observed stock, not adopter inventory balances. */
export function createPostgresFulfillmentStockSyncPort(db: PgExecutor, options: {
  sourceKey: string;
  inventoryClasses?: ReadonlyMap<string, 'sellable' | 'packaging' | null>;
  readLocalInventoryStock: FulfillmentStockSyncPort['readLocalInventoryStock'];
}): FulfillmentStockSyncPort {
  const source = options.sourceKey.trim();
  if (!source) throw new Error('fulfillment_stock_source_key_required');
  return {
    readLocalInventoryStock: at => options.readLocalInventoryStock(at),
    async readCursor() {
      const result = await db.query('SELECT status,last_stock_synced_at,last_movement_occurred_at,cursor FROM public.fulfillment_stock_sync_cursors WHERE source_key=$1', [source]);
      const row = result.rows[0];
      if (!row) return null;
      const cursor = row.cursor as Partial<SyncCursor>;
      return { ...cursor, status: row.status as SyncCursor['status'], lastStockSyncedAt: timestamp(row.last_stock_synced_at), lastMovementOccurredAt: timestamp(row.last_movement_occurred_at),
        continuation: cursor.continuation ?? { nextRef: null, startLocalDate: null, endLocalDate: null }, coverageGapSkus: cursor.coverageGapSkus ?? [], refusal: cursor.refusal ?? null };
    },
    async recordCursor(v) {
      await db.query(`INSERT INTO public.fulfillment_stock_sync_cursors(source_key,status,last_stock_synced_at,last_movement_occurred_at,cursor,error_code,updated_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT(source_key) DO UPDATE SET status=EXCLUDED.status,
        last_stock_synced_at=EXCLUDED.last_stock_synced_at,last_movement_occurred_at=EXCLUDED.last_movement_occurred_at,cursor=EXCLUDED.cursor,error_code=EXCLUDED.error_code,updated_at=now()`,
      [source,v.status,v.lastStockSyncedAt,v.lastMovementOccurredAt,JSON.stringify({ syncRunId: v.syncRunId, counts: v.counts, items: v.items, alerts: v.alerts, staleSync: v.staleSync, error: v.error, continuation: { nextRef: v.continuation.nextRef, startLocalDate: v.continuation.startLocalDate, endLocalDate: v.continuation.endLocalDate }, coverageGapSkus: [...(v.coverageGapSkus ?? [])], ...(v.movementRefusal ? { movementRefusal: v.movementRefusal } : {}), refusal: v.refusal }),v.error?.reason ?? v.refusal?.reason ?? null]);
    },
    async readSkuInventoryClasses(skus) {
      if (!skus.length) return new Map();
      const rows = (await db.query('SELECT sku FROM public.catalog_skus WHERE sku=ANY($1::text[])', [skus])).rows;
      const known = new Set(rows.map(row => row.sku));
      return new Map(skus.map(sku => [sku, options.inventoryClasses?.has(sku) ? options.inventoryClasses.get(sku)! : known.has(sku) ? 'sellable' as const : null]));
    },
    async readActiveReservations(skus, at) {
      const result = await db.query(`SELECT line.sku,sum(line.quantity)::integer AS quantity FROM public.fulfillment_inventory_reservation_lines line
        JOIN public.fulfillment_inventory_reservations reservation ON reservation.id=line.reservation_id
        WHERE reservation.source_key=$1 AND line.sku=ANY($2::text[]) AND reservation.status IN ('held','committed')
        AND (reservation.status='committed' OR reservation.expires_at>$3::timestamptz) GROUP BY line.sku`, [source,skus,at]);
      return new Map(result.rows.map(row => [String(row.sku), Number(row.quantity)]));
    },
    recordStockSnapshot(v) {
      const s=v.snapshot, l=v.local;
      return nativeCall(db,'fulfillment_record_stock_snapshot',[source,v.requestKey,fingerprint(v),s.skuRef,s.totalQuantity,s.forSaleQuantity,s.reservedOrUnavailableQuantity,l.onHand,l.reserved,l.unavailable,l.safetyStock,v.inventoryClass,s.syncRunId]);
    },
    async recordStockSnapshotBatch(inputs) {
      if (!inputs.length) return [];
      const ordered = orderBatch(inputs, (a, b) => compareText(a.requestKey, b.requestKey) || compareText(a.snapshot.skuRef, b.snapshot.skuRef));
      const result = await db.query(
        `SELECT t.ord, public.fulfillment_record_stock_snapshot(
          $1::text, t.request_key, t.fingerprint, t.sku, t.provider_total, t.provider_for_sale,
          t.provider_reserved_unavail, t.local_on_hand, t.local_reserved, t.local_unavailable,
          t.local_safety, t.inventory_class, t.sync_run_id
        ) AS response
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[], $7::integer[],
          $8::integer[], $9::integer[], $10::integer[], $11::integer[], $12::text[], $13::text[]
        ) WITH ORDINALITY AS t(
          request_key, fingerprint, sku, provider_total, provider_for_sale,
          provider_reserved_unavail, local_on_hand, local_reserved, local_unavailable,
          local_safety, inventory_class, sync_run_id, ord
        ) ORDER BY t.ord`,
        [
          source,
          ordered.map(({ item }) => item.requestKey),
          ordered.map(({ item }) => fingerprint(item)),
          ordered.map(({ item }) => item.snapshot.skuRef),
          ordered.map(({ item }) => item.snapshot.totalQuantity),
          ordered.map(({ item }) => item.snapshot.forSaleQuantity),
          ordered.map(({ item }) => item.snapshot.reservedOrUnavailableQuantity),
          ordered.map(({ item }) => item.local.onHand),
          ordered.map(({ item }) => item.local.reserved),
          ordered.map(({ item }) => item.local.unavailable),
          ordered.map(({ item }) => item.local.safetyStock),
          ordered.map(({ item }) => item.inventoryClass),
          ordered.map(({ item }) => item.snapshot.syncRunId),
        ],
      );
      return scatterBatchResponses<{ replayed: boolean; readBack: boolean }>(ordered, result.rows);
    },
    recordProviderStockCurrent(v) {
      const s=v.snapshot;
      return nativeCall(db,'fulfillment_record_stock_current',[source,v.requestKey,fingerprint(v),s.skuRef,s.totalQuantity,s.forSaleQuantity,s.reservedOrUnavailableQuantity,v.inventoryClass,v.lastSyncedAt,v.staleAfter,s.syncRunId]);
    },
    async recordProviderStockCurrentBatch(inputs) {
      if (!inputs.length) return [];
      const ordered = orderBatch(inputs, (a, b) => compareText(a.snapshot.skuRef, b.snapshot.skuRef) || compareText(a.requestKey, b.requestKey));
      const result = await db.query(
        `SELECT t.ord, public.fulfillment_record_stock_current(
          $1::text, t.request_key, t.fingerprint, t.sku, t.total_qty, t.for_sale_qty,
          t.reserved_unavail_qty, t.inventory_class, t.last_synced_at, t.stale_after, t.sync_run_id
        ) AS response
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[], $7::integer[],
          $8::text[], $9::timestamptz[], $10::timestamptz[], $11::text[]
        ) WITH ORDINALITY AS t(
          request_key, fingerprint, sku, total_qty, for_sale_qty, reserved_unavail_qty,
          inventory_class, last_synced_at, stale_after, sync_run_id, ord
        ) ORDER BY t.ord`,
        [
          source,
          ordered.map(({ item }) => item.requestKey),
          ordered.map(({ item }) => fingerprint(item)),
          ordered.map(({ item }) => item.snapshot.skuRef),
          ordered.map(({ item }) => item.snapshot.totalQuantity),
          ordered.map(({ item }) => item.snapshot.forSaleQuantity),
          ordered.map(({ item }) => item.snapshot.reservedOrUnavailableQuantity),
          ordered.map(({ item }) => item.inventoryClass),
          ordered.map(({ item }) => item.lastSyncedAt),
          ordered.map(({ item }) => item.staleAfter),
          ordered.map(({ item }) => item.snapshot.syncRunId),
        ],
      );
      return scatterBatchResponses<{ replayed: boolean; readBack: boolean }>(ordered, result.rows);
    },
    recordMovement(v) {
      const { providerRef, syncRunId, collectedAt, sourceRevision, revisionSource, skuRef, quantityKind, quantity, occurredAt, operationType, documentRef, lotRef, expirationDate } = v.movement;
      const movement = { providerRef, syncRunId, collectedAt, sourceRevision, revisionSource, skuRef, quantityKind, quantity, occurredAt, operationType, documentRef, lotRef, expirationDate };
      return nativeCall(db,'fulfillment_record_stock_movement',[source,v.requestKey,fingerprint({ requestKey: v.requestKey, movement }),JSON.stringify(movement)]);
    },
    recordLowStockEvidence: v => nativeCall(db,'fulfillment_record_stock_evidence',[source,v.requestKey,
      // Quantities, severity and run evidence are observations of the same alert identity.
      fingerprint({ requestKey: v.requestKey, skuRef: v.skuRef, thresholdKind: v.thresholdKind }),
      v.skuRef,v.thresholdKind,v.severity,v.providerForSaleQuantity,v.localAvailableQuantity]),
    async recordLowStockEvidenceBatch(inputs) {
      if (!inputs.length) return [];
      const ordered = orderBatch(inputs, (a, b) => compareText(a.requestKey, b.requestKey) || compareText(a.skuRef, b.skuRef) || compareText(a.thresholdKind, b.thresholdKind));
      const result = await db.query(
        `SELECT t.ord, public.fulfillment_record_stock_evidence(
          $1::text, t.request_key, t.fingerprint, t.sku, t.threshold_kind, t.severity,
          t.provider_for_sale, t.local_available
        ) AS response
        FROM unnest(
          $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::integer[], $8::integer[]
        ) WITH ORDINALITY AS t(
          request_key, fingerprint, sku, threshold_kind, severity, provider_for_sale, local_available, ord
        ) ORDER BY t.ord`,
        [
          source,
          ordered.map(({ item }) => item.requestKey),
          ordered.map(({ item }) => fingerprint({ requestKey: item.requestKey, skuRef: item.skuRef, thresholdKind: item.thresholdKind })),
          ordered.map(({ item }) => item.skuRef),
          ordered.map(({ item }) => item.thresholdKind),
          ordered.map(({ item }) => item.severity),
          ordered.map(({ item }) => item.providerForSaleQuantity),
          ordered.map(({ item }) => item.localAvailableQuantity),
        ],
      );
      return scatterBatchResponses<{ replayed: boolean }>(ordered, result.rows);
    },
    resolveLowStockEvidence: v => nativeCall(db,'fulfillment_resolve_stock_evidence',[source,v.skuRef,v.activeThresholdKinds,v.syncRunId]),
    async resolveLowStockEvidenceBatch(inputs) {
      if (!inputs.length) return [];
      const ordered = orderBatch(inputs, (a, b) => compareText(a.skuRef, b.skuRef) || compareText(a.syncRunId, b.syncRunId));
      const payload = ordered.map(({ item }) => ({
        skuRef: item.skuRef,
        activeThresholdKinds: item.activeThresholdKinds,
        syncRunId: item.syncRunId,
      }));
      const result = await db.query(
        `SELECT t.ord, public.fulfillment_resolve_stock_evidence(
          $1::text,
          t.elem->>'skuRef',
          ARRAY(SELECT jsonb_array_elements_text(t.elem->'activeThresholdKinds')),
          t.elem->>'syncRunId'
        ) AS response
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(elem, ord)
        ORDER BY t.ord`,
        [source, JSON.stringify(payload)],
      );
      return scatterBatchResponses<{ resolved: number }>(ordered, result.rows);
    },
  };
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function orderBatch<T>(inputs: readonly T[], compare: (a: T, b: T) => number): { item: T; index: number }[] {
  return inputs.map((item, index) => ({ item, index })).sort((a, b) => compare(a.item, b.item) || a.index - b.index);
}
function scatterBatchResponses<T>(ordered: readonly { index: number }[], rows: readonly Record<string, unknown>[]): T[] {
  if (rows.length !== ordered.length) throw new Error('fulfillment_native_response_missing');
  const responses = new Array<T>(ordered.length);
  for (let i = 0; i < ordered.length; i += 1) {
    const response = rows[i]?.response;
    if (response === undefined) throw new Error('fulfillment_native_response_missing');
    responses[ordered[i]!.index] = response as T;
  }
  return responses;
}
function timestamp(value: unknown): string | null { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null; }
function fingerprint(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
