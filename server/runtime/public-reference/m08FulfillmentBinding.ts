import { createFulfillmentServices, createPostgresFulfillmentDispatchStore, FULFILLMENT_NATIVE_UNSUPPORTED } from '@openlup/platform/fulfillment';
import type { FulfillmentDispatchRequest, FulfillmentServicesOptions } from '@openlup/platform/fulfillment/contracts';
import { createFulfillmentContribution } from '@openlup/platform/composition';
import type { RequiredSchema } from '@openlup/core/readiness';
import type { PostgresFulfillmentTransactionLane } from '../../adapters/postgres/dataGateway.js';

type Executor = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
type Attribution = { fulfillmentRef: string; actorUserId: string; idempotencyKey: string };

/** Inert, explicit native composition. Secrets and source mapping belong to host closures. */
export function createM08FulfillmentReferenceBinding(input: {
  enabled?: boolean;
  transactions: PostgresFulfillmentTransactionLane | null;
  preparation?: {
    /** Read authoritative contact/selection/withholding using this locked transaction only. */
    readAuthoritative(db: Executor, fulfillmentRef: string): Promise<{ candidate: FulfillmentDispatchRequest | null; withheld: boolean }>;
  };
  services: Omit<FulfillmentServicesOptions, 'enabled' | 'store'>;
  version: string;
  requiredSchema: RequiredSchema;
}) {
  const { transactions, preparation } = input;
  const bound = typeof transactions?.run === 'function' && typeof preparation?.readAuthoritative === 'function';
  const unsupported = FULFILLMENT_NATIVE_UNSUPPORTED;
  const run = <T>(work: (db: Executor) => Promise<T>) => transactions!.run(gateway => work(gateway as Executor));
  const executor: Executor = { query: (sql, values) => run(db => db.query(sql, values)) };
  async function lock(db: Executor, ref: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('native-dispatch|' || $1::uuid::text,0))", [ref]);
    const { rows } = await db.query('SELECT id, order_id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE', [ref]);
    if (!rows[0]) throw new Error('fulfillment_preparation_shipment_missing');
    return rows[0];
  }
  async function synchronize(db: Executor, ref: string, order: unknown) {
    const { candidate, withheld } = await preparation!.readAuthoritative(db, ref);
    if (!candidate) {
      await db.query('DELETE FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [ref]);
      return { candidate: null, disposition: 'withheld' as const, contactRevision: null };
    }
    const revision = candidate.contactRevision;
    const provider = candidate.selection.providerRef;
    if (candidate.fulfillmentRef !== ref || candidate.orderRef !== order || !provider?.trim()
      || !Number.isSafeInteger(revision.revision) || revision.revision < 0
      || !Number.isSafeInteger(revision.schemaVersion) || revision.schemaVersion < 1 || !revision.source.trim()
      || typeof withheld !== 'boolean') throw new Error('fulfillment_preparation_identity_invalid');
    // Explicit projection: recipient, raw command, credentials and extra host fields cannot persist here.
    await db.query(`INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref,withheld)
      VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO UPDATE
      SET contact_revision=EXCLUDED.contact_revision,provider_ref=EXCLUDED.provider_ref,withheld=EXCLUDED.withheld`,
    [ref, JSON.stringify({ schemaVersion: revision.schemaVersion, source: revision.source, revision: revision.revision }), provider, withheld]);
    return { candidate, disposition: withheld ? 'withheld' as const : 'ready' as const, contactRevision: revision.revision };
  }
  const readPrepared = (ref: string) => run(async db => {
    const shipment = await lock(db, ref);
    return synchronize(db, ref, shipment.order_id);
  });
  const store = bound ? createPostgresFulfillmentDispatchStore(executor, {
    async prepare(ref) { const { disposition, contactRevision } = await readPrepared(ref); return { disposition, contactRevision }; },
    async readCandidate(ref) { return (await readPrepared(ref)).candidate; },
  }) : null;
  const services = createFulfillmentServices({ ...input.services, enabled: input.enabled, store,
    readiness: async () => bound ? input.services.readiness() : { ready: false, refusal: unsupported },
  });
  const contribution = createFulfillmentContribution({ version: input.version, requiredSchema: input.requiredSchema,
    fulfillment: { dispatch: bound ? services.runDispatch : null }, handlers: [], schedules: [], routes: [],
  });
  return {
    services, ...contribution,
    /** No scheduler is registered. Preparation itself is also off until explicitly selected. */
    async prepare(ref: string) {
      const state = await services.readiness();
      if (!state.ready) return 'kind' in state.refusal ? state.refusal : { kind: 'refused' as const, refusal: state.refusal };
      const { disposition, contactRevision } = await readPrepared(ref);
      return { disposition, contactRevision };
    },
    /** Host edit, attribution/replay receipt and context update commit or roll back together. */
    async editAuthoritative(attribution: Attribution, apply: (db: Executor, attribution: Attribution) => Promise<void>) {
      const state = await services.readiness();
      if (!state.ready) return 'kind' in state.refusal ? state.refusal : { kind: 'refused' as const, refusal: state.refusal };
      if (!attribution.actorUserId.trim() || !attribution.idempotencyKey.trim()) throw new Error('fulfillment_preparation_attribution_required');
      return run(async db => {
        const shipment = await lock(db, attribution.fulfillmentRef);
        await apply(db, attribution);
        const { disposition, contactRevision } = await synchronize(db, attribution.fulfillmentRef, shipment.order_id);
        return { disposition, contactRevision };
      });
    },
  };
}
