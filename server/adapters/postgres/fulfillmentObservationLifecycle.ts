import type { verifyAndNormalizeFulfillmentObservation } from "@openlup/platform/fulfillment";
import type { DispatchRecord } from "@openlup/platform/fulfillment/contracts";
import type { PgQueryExecutor } from "./queryBuilder.js";

type Lifecycle = Pick<Parameters<typeof verifyAndNormalizeFulfillmentObservation>[0]["lifecycle"],
  "findDispatchRef" | "acknowledgeDispatchAcceptance">;
type Observation = Parameters<Lifecycle["findDispatchRef"]>[0];

const READ = `SELECT public.fulfillment_dispatch_read(ref)
  || jsonb_build_object('acceptance',ref.acceptance) AS response
  FROM public.fulfillment_dispatch_refs ref
  WHERE ref.shipment_id=$1::uuid AND ref.evidence->>'providerRef'=$2
    AND ref.mode<>'shadow'`;
const ACK = "SELECT public.fulfillment_dispatch_finish($1::uuid,$2::jsonb,true) AS response";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact native shipment correlation for a selected, verified provider. The host
 * must normalize its immutable shipment identity before recording an observation.
 * Merchant order numbers and provider parcel numbers are not lookup identities.
 * The caller owns the existing capability-local transaction and login authority.
 */
export function createPostgresFulfillmentObservationLifecycle(db: PgQueryExecutor, options: {
  providerRef: string;
  acceptanceKeys(fulfillmentRef: string): { providerAttemptKey: string; labelKey: string };
}): Lifecycle {
  const providerRef = options.providerRef;
  if (!providerRef.trim()) throw new Error("fulfillment_observation_provider_required");

  async function read(observation: Observation): Promise<DispatchRecord | null> {
    if (observation.fact.providerKind !== providerRef) throw new Error("fulfillment_observation_provider_mismatch");
    const correlation = observation.correlation;
    if (!correlation.fulfillmentRef || !uuid.test(correlation.fulfillmentRef)) return null;
    const result = await db.query(READ, [correlation.fulfillmentRef, providerRef]);
    const record = result.rows[0]?.response as DispatchRecord | undefined;
    if (!record) return null;
    if (result.rows.length !== 1 || record.fulfillmentRef !== correlation.fulfillmentRef
      || record.evidence.providerRef !== providerRef || record.mode === "shadow"
      || (correlation.orderRef !== null && correlation.orderRef !== record.orderRef)
      || (correlation.parcelRef !== null && correlation.parcelRef !== record.parcelRef)
      || (correlation.externalRef !== null && record.externalRef !== null && correlation.externalRef !== record.externalRef)) {
      throw new Error("fulfillment_observation_correlation_conflict");
    }
    return record;
  }

  return {
    async findDispatchRef(observation) {
      const record = await read(observation);
      return record ? { orderRef: record.orderRef, fulfillmentRef: record.fulfillmentRef,
        dispatchRef: record.dispatchRef, externalRef: record.externalRef } : null;
    },
    async acknowledgeDispatchAcceptance(ref, observation) {
      // Read again: findDispatchRef is not a cached authorization or acceptance
      // proof. The SQL writer locks and rechecks the current evidence/state too.
      const record = await read(observation);
      if (!record || record.dispatchRef !== ref.dispatchRef || record.orderRef !== ref.orderRef
        || record.fulfillmentRef !== ref.fulfillmentRef) throw new Error("fulfillment_observation_dispatch_changed");
      const externalRef = observation.correlation.externalRef ?? record.externalRef;
      if (!externalRef?.trim()) throw new Error("fulfillment_observation_external_ref_required");
      const keys = options.acceptanceKeys(record.fulfillmentRef);
      if (!keys.providerAttemptKey.trim() || !keys.labelKey.trim() || keys.providerAttemptKey === keys.labelKey) {
        throw new Error("fulfillment_observation_acceptance_keys_invalid");
      }
      const acceptance = record.acceptance ?? { kind: "accepted" as const, externalRef, evidence: record.evidence, ...keys };
      if (acceptance.externalRef !== externalRef || acceptance.providerAttemptKey !== keys.providerAttemptKey
        || acceptance.labelKey !== keys.labelKey) throw new Error("fulfillment_observation_acceptance_conflict");
      // Preserve the exact retained acceptance on replay, including its recovery
      // and diagnostic fields. A new observation is not a new dispatch command.
      const result = await db.query(ACK, [record.dispatchRef, JSON.stringify(acceptance)]);
      const response = result.rows[0]?.response as { acknowledged?: boolean; record?: DispatchRecord } | undefined;
      if (response?.acknowledged !== true || response.record?.dispatchRef !== record.dispatchRef
        || response.record.status !== "created" || response.record.externalRef !== externalRef) {
        throw new Error("fulfillment_observation_acknowledgement_invalid");
      }
    },
  };
}
