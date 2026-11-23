import { createHash } from 'node:crypto';
import type { FulfillmentStockSyncPort, SyncCursor } from './contracts/index.js';
import { nativeCall, type PgExecutor } from './postgresDispatchStore.js';

const stockReplayConflict = 'fulfillment_stock_current_idempotency_conflict';

/** Stock replay with different inputs. */
export class FulfillmentStockReplayConflictError extends Error {
  constructor(cause: unknown) {
    super(stockReplayConflict, { cause });
    this.name = 'FulfillmentStockReplayConflictError';
  }
}

function stockCurrentRefusal(error: unknown): FulfillmentStockReplayConflictError | undefined {
  if (error instanceof Error && error.message === stockReplayConflict && 'code' in error && error.code === '23505'
    && 'detail' in error && error.detail === 'openlup:stock_current:replay_conflict') {
    return new FulfillmentStockReplayConflictError(error);
  }
}

/** The native catalogue has observed stock, not adopter inventory balances. */
export function createPostgresFulfillmentStockSyncPort(db: PgExecutor, options: {
  sourceKey: string;
  inventoryClasses?: ReadonlyMap<string, 'sellable' | 'packaging' | null>;
  readLocalInventoryStock: FulfillmentStockSyncPort['readLocalInventoryStock'];
}): FulfillmentStockSyncPort {
  const source = options.sourceKey.trim();
  if (!source) throw new Error('fulfillment_stock_source_key_required');
  const currentStockExecutor: PgExecutor = {
    async query(text, values) {
      try { return await db.query(text, values); }
      catch (error) { throw stockCurrentRefusal(error) ?? error; }
    },
  };
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
      const result = await db.query(
        `WITH ordered AS MATERIALIZED (
          SELECT t.ord, t.request_key, t.fingerprint, t.sku, t.provider_total, t.provider_for_sale,
            t.provider_reserved_unavail, t.local_on_hand, t.local_reserved, t.local_unavailable,
            t.local_safety, t.inventory_class, t.sync_run_id
          FROM unnest(
            $2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[], $7::integer[],
            $8::integer[], $9::integer[], $10::integer[], $11::integer[], $12::text[], $13::text[]
          ) WITH ORDINALITY AS t(
            request_key, fingerprint, sku, provider_total, provider_for_sale,
            provider_reserved_unavail, local_on_hand, local_reserved, local_unavailable,
            local_safety, inventory_class, sync_run_id, ord
          )
          ORDER BY t.request_key, t.ord
        )
        SELECT ordered.ord, public.fulfillment_record_stock_snapshot(
          $1::text, ordered.request_key, ordered.fingerprint, ordered.sku, ordered.provider_total,
          ordered.provider_for_sale, ordered.provider_reserved_unavail, ordered.local_on_hand,
          ordered.local_reserved, ordered.local_unavailable, ordered.local_safety,
          ordered.inventory_class, ordered.sync_run_id
        ) AS response
        FROM ordered`,
        [
          source,
          inputs.map((item) => item.requestKey),
          inputs.map((item) => fingerprint(item)),
          inputs.map((item) => item.snapshot.skuRef),
          inputs.map((item) => item.snapshot.totalQuantity),
          inputs.map((item) => item.snapshot.forSaleQuantity),
          inputs.map((item) => item.snapshot.reservedOrUnavailableQuantity),
          inputs.map((item) => item.local.onHand),
          inputs.map((item) => item.local.reserved),
          inputs.map((item) => item.local.unavailable),
          inputs.map((item) => item.local.safetyStock),
          inputs.map((item) => item.inventoryClass),
          inputs.map((item) => item.snapshot.syncRunId),
        ],
      );
      return scatterBatchResponses<{ replayed: boolean; readBack: boolean }>(inputs.length, result.rows);
    },
    recordProviderStockCurrent(v) {
      const input = structuredClone(v);
      const { snapshot } = input;
      const values = [source, input.requestKey, fingerprint(input), snapshot.skuRef, snapshot.totalQuantity, snapshot.forSaleQuantity,
        snapshot.reservedOrUnavailableQuantity, input.inventoryClass, input.lastSyncedAt, input.staleAfter, snapshot.syncRunId];
      return nativeCall(currentStockExecutor, 'fulfillment_record_stock_current', values);
    },
    async recordProviderStockCurrentBatch(inputs) {
      if (!inputs.length) return [];
      // Order inside PostgreSQL by sku (database collation) + ord so row locks on
      // fulfillment_stock_current match ORDER BY stock.sku FOR UPDATE while keeping caller order within a SKU.
      const result = await db.query(
        `WITH ordered AS MATERIALIZED (
          SELECT t.ord, t.request_key, t.fingerprint, t.sku, t.total_qty, t.for_sale_qty,
            t.reserved_unavail_qty, t.inventory_class, t.last_synced_at, t.stale_after, t.sync_run_id
          FROM unnest(
            $2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[], $7::integer[],
            $8::text[], $9::timestamptz[], $10::timestamptz[], $11::text[]
          ) WITH ORDINALITY AS t(
            request_key, fingerprint, sku, total_qty, for_sale_qty, reserved_unavail_qty,
            inventory_class, last_synced_at, stale_after, sync_run_id, ord
          )
          ORDER BY t.sku, t.ord
        )
        SELECT ordered.ord, public.fulfillment_record_stock_current(
          $1::text, ordered.request_key, ordered.fingerprint, ordered.sku, ordered.total_qty,
          ordered.for_sale_qty, ordered.reserved_unavail_qty, ordered.inventory_class,
          ordered.last_synced_at, ordered.stale_after, ordered.sync_run_id
        ) AS response
        FROM ordered`,
        [
          source,
          inputs.map((item) => item.requestKey),
          inputs.map((item) => fingerprint(item)),
          inputs.map((item) => item.snapshot.skuRef),
          inputs.map((item) => item.snapshot.totalQuantity),
          inputs.map((item) => item.snapshot.forSaleQuantity),
          inputs.map((item) => item.snapshot.reservedOrUnavailableQuantity),
          inputs.map((item) => item.inventoryClass),
          inputs.map((item) => item.lastSyncedAt),
          inputs.map((item) => item.staleAfter),
          inputs.map((item) => item.snapshot.syncRunId),
        ],
      );
      return scatterBatchResponses<{ replayed: boolean; readBack: boolean }>(inputs.length, result.rows);
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
      // Align cross-SKU lock ordering with resolveLowStockEvidenceBatch in database collation.
      const result = await db.query(
        `WITH ordered AS MATERIALIZED (
          SELECT t.ord, t.request_key, t.fingerprint, t.sku, t.threshold_kind, t.severity,
            t.provider_for_sale, t.local_available
          FROM unnest(
            $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::integer[], $8::integer[]
          ) WITH ORDINALITY AS t(
            request_key, fingerprint, sku, threshold_kind, severity, provider_for_sale, local_available, ord
          )
          ORDER BY t.sku, t.ord
        )
        SELECT ordered.ord, public.fulfillment_record_stock_evidence(
          $1::text, ordered.request_key, ordered.fingerprint, ordered.sku, ordered.threshold_kind,
          ordered.severity, ordered.provider_for_sale, ordered.local_available
        ) AS response
        FROM ordered`,
        [
          source,
          inputs.map((item) => item.requestKey),
          inputs.map((item) => fingerprint({ requestKey: item.requestKey, skuRef: item.skuRef, thresholdKind: item.thresholdKind })),
          inputs.map((item) => item.skuRef),
          inputs.map((item) => item.thresholdKind),
          inputs.map((item) => item.severity),
          inputs.map((item) => item.providerForSaleQuantity),
          inputs.map((item) => item.localAvailableQuantity),
        ],
      );
      return scatterBatchResponses<{ replayed: boolean }>(inputs.length, result.rows);
    },
    resolveLowStockEvidence: v => nativeCall(db,'fulfillment_resolve_stock_evidence',[source,v.skuRef,v.activeThresholdKinds,v.syncRunId]),
    async resolveLowStockEvidenceBatch(inputs) {
      if (!inputs.length) return [];
      const payload = inputs.map((item) => ({
        skuRef: item.skuRef,
        activeThresholdKinds: item.activeThresholdKinds,
        syncRunId: item.syncRunId,
      }));
      const result = await db.query(
        `WITH ordered AS MATERIALIZED (
          SELECT t.ord, t.elem
          FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(elem, ord)
          ORDER BY t.elem->>'skuRef', t.ord
        )
        SELECT ordered.ord, public.fulfillment_resolve_stock_evidence(
          $1::text,
          ordered.elem->>'skuRef',
          ARRAY(SELECT jsonb_array_elements_text(ordered.elem->'activeThresholdKinds')),
          ordered.elem->>'syncRunId'
        ) AS response
        FROM ordered`,
        [source, JSON.stringify(payload)],
      );
      return scatterBatchResponses<{ resolved: number }>(inputs.length, result.rows);
    },
  };
}
function scatterBatchResponses<T>(expectedCount: number, rows: readonly Record<string, unknown>[]): T[] {
  if (rows.length !== expectedCount) throw new Error('fulfillment_native_response_missing');
  const responses = new Array<T>(expectedCount);
  const seen = new Array<boolean>(expectedCount).fill(false);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const response = row?.response;
    const rawOrd = row?.ord;
    const ord = typeof rawOrd === 'number' ? rawOrd : typeof rawOrd === 'string' && /^\d+$/.test(rawOrd) ? Number(rawOrd) : Number.NaN;
    if (response === undefined || !Number.isInteger(ord) || ord < 1 || ord > expectedCount || seen[ord - 1]) {
      throw new Error('fulfillment_native_response_missing');
    }
    seen[ord - 1] = true;
    responses[ord - 1] = response as T;
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
