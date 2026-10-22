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
      [source,v.status,v.lastStockSyncedAt,v.lastMovementOccurredAt,JSON.stringify({ syncRunId: v.syncRunId, counts: v.counts, items: v.items, alerts: v.alerts, staleSync: v.staleSync, error: v.error, continuation: { nextRef: v.continuation.nextRef, startLocalDate: v.continuation.startLocalDate, endLocalDate: v.continuation.endLocalDate }, coverageGapSkus: [...(v.coverageGapSkus ?? [])], refusal: v.refusal }),v.error?.reason ?? v.refusal?.reason ?? null]);
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
    recordProviderStockCurrent(v) {
      const s=v.snapshot;
      return nativeCall(db,'fulfillment_record_stock_current',[source,v.requestKey,fingerprint(v),s.skuRef,s.totalQuantity,s.forSaleQuantity,s.reservedOrUnavailableQuantity,v.inventoryClass,v.lastSyncedAt,v.staleAfter,s.syncRunId]);
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
    resolveLowStockEvidence: v => nativeCall(db,'fulfillment_resolve_stock_evidence',[source,v.skuRef,v.activeThresholdKinds,v.syncRunId]),
  };
}
function timestamp(value: unknown): string | null { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null; }
function fingerprint(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
