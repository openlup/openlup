import type { FulfillmentDispatchRequest } from '../contracts/dispatch.js';
import { nativeCall, type PgExecutor } from '../postgresDispatchStore.js';
import { applyParcelContact } from './parcelContact.js';

/** Native recorded facts only. Structural row refusals withhold that row, never the rest of a batch. */
export function createPostgresFulfillmentDispatchComposition(db: PgExecutor, selection: { portKey: string; providerRef: string }) {
  if (!selection.portKey.trim() || !selection.providerRef.trim()) throw new Error('fulfillment_dispatch_selection_required');
  const readAuthoritative = async (tx: PgExecutor, ref: string) => {
    const row = await nativeCall<(Pick<FulfillmentDispatchRequest, 'requestKey' | 'fulfillmentRef' | 'orderRef' | 'orderNumber' | 'parcelRef' | 'lines'> & { contact?: unknown; recovery?: boolean }) | null>(
      tx, 'fulfillment_native_dispatch_read_candidate', [ref, selection.providerRef]);
    if (!row) return { candidate: null, withheld: true };
    // Recovery is identity-only; the worker recognizes persisted proof before preparation.
    const candidate = applyParcelContact({ ...row, lines: row.lines ?? [] } as FulfillmentDispatchRequest, row.contact);
    return { candidate, withheld: false };
  };
  return {
    readAuthoritative,
    async listCandidates(limit: number) {
      const { rows } = await db.query('SELECT shipment_id FROM public.fulfillment_native_dispatch_candidate_ids($1,$2,$3)', [selection.portKey, selection.providerRef, limit]);
      if (rows.length === 0) return [];
      const ids = rows.map(row => String(row.shipment_id));
      try {
        const batch = await db.query(
          `SELECT id.shipment_id, public.fulfillment_native_dispatch_read_candidate(id.shipment_id, $2) AS response
           FROM unnest($1::uuid[]) WITH ORDINALITY AS id(shipment_id, ord)
           ORDER BY id.ord`,
          [ids, selection.providerRef],
        );
        const candidates: FulfillmentDispatchRequest[] = [];
        for (const entry of batch.rows) {
          if (entry.response === undefined) throw new Error('fulfillment_native_response_missing');
          const row = entry.response as (Pick<FulfillmentDispatchRequest, 'requestKey' | 'fulfillmentRef' | 'orderRef' | 'orderNumber' | 'parcelRef' | 'lines'> & { contact?: unknown; recovery?: boolean }) | null;
          if (!row) continue;
          candidates.push(applyParcelContact({ ...row, lines: row.lines ?? [] } as FulfillmentDispatchRequest, row.contact));
        }
        return candidates;
      } catch (error) {
        if ((error as { code?: string }).code !== '22023') throw error;
        // Isolate a concurrent 22023 row refusal so it never withholds the rest of the batch.
        const candidates: FulfillmentDispatchRequest[] = [];
        for (const id of ids) {
          try {
            const { candidate } = await readAuthoritative(db, id);
            if (candidate) candidates.push(candidate);
          } catch (rowError) {
            if ((rowError as { code?: string }).code !== '22023') throw rowError;
          }
        }
        return candidates;
      }
    },
  };
}
