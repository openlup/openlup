import { createFulfillmentServices, createPostgresFulfillmentDispatchStore } from '../index.js';
import type { FulfillmentDispatchRequest, FulfillmentServicesOptions } from '../contracts/index.js';
import type { RequiredSchema } from '@openlup/core/readiness';
import { applyParcelContact, parcelContact, applyFrozenParcel } from './parcelContact.js';

type Executor = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
type Attribution = { fulfillmentRef: string; actorUserId: string; idempotencyKey: string };

/** Inert, explicit native composition. Secrets and source mapping belong to host closures. */
export function createNativeFulfillmentBinding(input: {
  enabled?: boolean;
  transactions: {
    run<T>(work: (db: unknown) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  } | null;
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
  const run = <T>(work: (db: Executor) => Promise<T>) => transactions!.run(gateway => work(gateway as Executor));
  const executor: Executor = { query: (sql, values) => run(db => db.query(sql, values)) };
  async function lock(db: Executor, ref: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('native-dispatch|' || $1::uuid::text,0))", [ref]);
    const { rows } = await db.query('SELECT id, order_id, replaces_shipment_id FROM public.fulfillment_shipments WHERE id=$1 FOR UPDATE', [ref]);
    if (!rows[0]) throw new Error('fulfillment_preparation_shipment_missing');
    return rows[0];
  }
  async function synchronize(db: Executor, ref: string, order: unknown, replacement: unknown, sourceEdit = false, readContact = false) {
    const prepared = await preparation!.readAuthoritative(db, ref);
    let candidate = prepared.candidate;
    const { withheld } = prepared;
    if (!candidate) {
      await db.query('DELETE FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [ref]);
      return { candidate: null, disposition: 'withheld' as const, contactRevision: null };
    }
    if (replacement) {
      const result = await db.query('SELECT public.fulfillment_read_replacement_preparation($1::uuid) AS value', [ref]);
      candidate = applyFrozenParcel(candidate, result.rows[0]?.value);
    }
    const revision = candidate.contactRevision;
    const provider = candidate.selection.providerRef;
    if (candidate.fulfillmentRef !== ref || candidate.orderRef !== order || !provider?.trim()
      || !Number.isSafeInteger(revision.revision) || revision.revision < 0
      || !Number.isSafeInteger(revision.schemaVersion) || revision.schemaVersion < 1 || !revision.source.trim()
      || typeof withheld !== 'boolean') throw new Error('fulfillment_preparation_identity_invalid');
    // Operational revision and withholding remain authoritative host facts.
    // Only an explicit source edit can reroute an existing context.
    const pinned = { schemaVersion: revision.schemaVersion, source: revision.source, revision: revision.revision };
    await db.query(`INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref,withheld)
      VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO UPDATE
      SET contact_revision=EXCLUDED.contact_revision,${sourceEdit ? 'provider_ref=EXCLUDED.provider_ref,' : ''}withheld=EXCLUDED.withheld`,
    [ref, JSON.stringify(pinned), provider, withheld]);
    // The capture command keeps preparation metadata-only. Candidate reads require
    // its retained payload, including a previously inferred contact.
    const captured = await db.query('SELECT public.fulfillment_capture_parcel_contact($1::uuid,$2::jsonb) AS value', [ref, JSON.stringify(parcelContact(candidate))]);
    const contact = captured.rows[0]?.value as { erased?: boolean; contact?: unknown };
    if (contact?.erased) {
      await db.query('DELETE FROM public.fulfillment_dispatch_contexts WHERE shipment_id=$1', [ref]);
      return { candidate: null, disposition: 'withheld' as const, contactRevision: null };
    }
    let frozen: FulfillmentDispatchRequest | null = null;
    if (readContact) {
      if (!contact || !('contact' in contact)) throw new Error('fulfillment_preparation_contact_missing');
      frozen = { ...applyParcelContact(candidate, contact.contact), contactRevision: pinned };
    }
    return { candidate: frozen, disposition: withheld ? 'withheld' as const : 'ready' as const, contactRevision: pinned.revision };
  }
  const readPrepared = (ref: string, readContact = false) => run(async db => {
    const shipment = await lock(db, ref);
    return synchronize(db, ref, shipment.order_id, shipment.replaces_shipment_id, false, readContact);
  });
  const store = bound ? createPostgresFulfillmentDispatchStore(executor, {
    async prepare(ref) { const { disposition, contactRevision } = await readPrepared(ref); return { disposition, contactRevision }; },
    async readCandidate(ref) { return (await readPrepared(ref, true)).candidate; },
  }) : null;
  const services = createFulfillmentServices({ ...input.services, enabled: input.enabled, store });
  async function whenReady<T>(work: () => Promise<T>) {
    const state = await services.readiness();
    if (!state.ready) return 'kind' in state.refusal ? state.refusal : { kind: 'refused' as const, refusal: state.refusal };
    return work();
  }
  return {
    services, version: input.version, requiredSchema: input.requiredSchema, dispatch: bound ? services.runDispatch : null,
    /** No scheduler is registered. Preparation itself is also off until explicitly selected. */
    async prepare(ref: string) {
      return whenReady(async () => {
        const { disposition, contactRevision } = await readPrepared(ref);
        return { disposition, contactRevision };
      });
    },
    /** Host edit, attribution/replay receipt and context update commit or roll back together. */
    async editAuthoritative(attribution: Attribution, apply: (db: Executor, attribution: Attribution) => Promise<void>) {
      return whenReady(async () => {
        if (!attribution.actorUserId.trim() || !attribution.idempotencyKey.trim()) throw new Error('fulfillment_preparation_attribution_required');
        return run(async db => {
          const shipment = await lock(db, attribution.fulfillmentRef);
          await apply(db, attribution);
          const { disposition, contactRevision } = await synchronize(db, attribution.fulfillmentRef, shipment.order_id, shipment.replaces_shipment_id, true);
          return { disposition, contactRevision };
        });
      });
    },
  };
}

export { createPostgresFulfillmentCommerceReadPort, nativeFulfillmentCommerceResponseSchemas, type NativeFulfillmentCommerceOrder, type NativeFulfillmentCommerceReadPort } from "./commerceReads.js";

export { createPostgresFulfillmentOperatorPort, createPostgresParcelReservationConsumption } from "./operatorMutations.js";

export { createPostgresFulfillmentShipmentCommandPort } from './shipmentCommands.js';
