import type { DeliveryAlignmentPort } from './contracts/index.js';
import { nativeCall, type PgExecutor } from './postgresDispatchStore.js';
import { readDeliveryAlignment } from './deliveryAlignmentReadModel.js';

/** Trusted arrival ingestion only. Operator replacement attestation has no caller here. */
export function createPostgresDeliveryAlignmentPort(db: PgExecutor): DeliveryAlignmentPort {
  return {
    read: ref => readDeliveryAlignment(db, ref),
    async recordArrival(v) {
      const receipt = await nativeCall<{ replayed: boolean }>(db, 'fulfillment_record_alignment_arrival', [v.requestKey, v.parcelRef, v.deliveredAt, v.evidenceRef]);
      return { ...await readDeliveryAlignment(db, v.parcelRef), replayed: receipt.replayed };
    },
  };
}
