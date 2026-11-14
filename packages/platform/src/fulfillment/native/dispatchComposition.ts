import type { FulfillmentDispatchRequest } from '../contracts/dispatch.js';
import { nativeCall, type PgExecutor } from '../postgresDispatchStore.js';
import { applyParcelContact } from './parcelContact.js';

/** Native recorded facts only. Structural row refusals withhold that row, never the rest of a batch. */
export function createPostgresFulfillmentDispatchComposition(db: PgExecutor, selection: { portKey: string; providerRef: string }) {
  if (!selection.portKey.trim() || !selection.providerRef.trim()) throw new Error('fulfillment_dispatch_selection_required');
  const readAuthoritative = async (tx: PgExecutor, ref: string) => {
    const row = await nativeCall<(Pick<FulfillmentDispatchRequest, 'requestKey' | 'fulfillmentRef' | 'orderRef' | 'orderNumber' | 'parcelRef' | 'lines'> & { contact?: unknown; recovery?: boolean }) | null>(
      tx, 'fulfillment_dispatch_read_candidate', [ref, selection.providerRef]);
    if (!row) return { candidate: null, withheld: true };
    // Recovery is identity-only; the worker recognizes persisted proof before preparation.
    const candidate = applyParcelContact({ ...row, lines: row.lines ?? [] } as FulfillmentDispatchRequest, row.contact);
    return { candidate, withheld: false };
  };
  return {
    readAuthoritative,
    async listCandidates(limit: number) {
      const { rows } = await db.query('SELECT shipment_id FROM public.fulfillment_dispatch_candidate_ids($1,$2,$3)', [selection.portKey, selection.providerRef, limit]);
      const candidates: FulfillmentDispatchRequest[] = [];
      for (const row of rows) {
        try {
          const { candidate } = await readAuthoritative(db, String(row.shipment_id));
          if (candidate) candidates.push(candidate);
        } catch (error) {
          if ((error as { code?: string }).code !== '22023') throw error;
        }
      }
      return candidates;
    },
  };
}
