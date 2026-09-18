import type {
  OmsFulfillmentOperationRow,
  OmsOmnipackDispatchRefRow,
  OmsOmnipackStatusEvidenceRow,
  OmsProviderAttemptRow,
  OmsReleasedProviderExceptionHoldRow,
} from "../../../../../src/domains/commerce/omsFulfillmentSummary.js";
import { customerSafeEvidenceToken } from "../../../../../src/domains/fulfillment/types.js";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import type { CommerceOmsClient } from "./types.js";

const PROVIDER_ATTEMPT_COLUMNS = "fulfillment_order_id, provider_kind, status, provider_tracking_id, error, created_at";
const OMNIPACK_DISPATCH_REF_COLUMNS = "id, fulfillment_order_id, provider_order_id, dispatch_mode, status, error, created_at, updated_at";
const OMNIPACK_STATUS_EVIDENCE_COLUMNS = "id, fulfillment_order_id, provider_status, provider_sub_status, local_status, evidence_kind, occurred_at, created_at";
export async function readProviderAttempts(client: CommerceOmsClient, ids: string[]) {
  if (!ids.length) return [] as OmsProviderAttemptRow[];
  const result = await client
    .from("commerce_fulfillment_provider_attempts")
    .select(PROVIDER_ATTEMPT_COLUMNS)
    .in("fulfillment_order_id", ids)
    .order("created_at", { ascending: false });
  if (isOptionalProviderEvidenceTableError(result.error)) return [] as OmsProviderAttemptRow[];
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS provider attempts read failed");
  return (result.data ?? []) as OmsProviderAttemptRow[];
}

export async function readOmnipackDispatchRefs(client: CommerceOmsClient, ids: string[]) {
  if (!ids.length) return [] as OmsOmnipackDispatchRefRow[];
  const result = await client
    .from("omnipack_dispatch_refs")
    .select(OMNIPACK_DISPATCH_REF_COLUMNS)
    .in("fulfillment_order_id", ids)
    .order("created_at", { ascending: false });
  if (isOptionalProviderEvidenceTableError(result.error)) return [] as OmsOmnipackDispatchRefRow[];
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS OmniPack dispatch refs read failed");
  return (result.data ?? []) as OmsOmnipackDispatchRefRow[];
}

export async function readOmnipackStatusEvidence(client: CommerceOmsClient, ids: string[]) {
  if (!ids.length) return [] as OmsOmnipackStatusEvidenceRow[];
  const result = await client
    .from("omnipack_status_evidence")
    .select(OMNIPACK_STATUS_EVIDENCE_COLUMNS)
    .in("fulfillment_order_id", ids)
    .order("occurred_at", { ascending: false, nullsFirst: false });
  if (isOptionalProviderEvidenceTableError(result.error)) return [] as OmsOmnipackStatusEvidenceRow[];
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS OmniPack status evidence read failed");
  return ((result.data ?? []) as OmsOmnipackStatusEvidenceRow[]).map((row) => ({
    ...row,
    customer_status: customerSafeEvidenceToken(row.local_status, row.provider_status),
  }));
}

export async function readFulfillmentOperations(client: CommerceOmsClient, ids: string[]) {
  if (!ids.length) return [] as OmsFulfillmentOperationRow[];
  const result = await client
    .from("commerce_fulfillment_operations")
    .select("fulfillment_order_id, operation_type, occurred_at")
    .in("fulfillment_order_id", ids)
    .order("occurred_at", { ascending: false });
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS fulfillment operations list read failed");
  return (result.data ?? []) as OmsFulfillmentOperationRow[];
}

export async function readReleasedProviderExceptionHolds(
  client: CommerceOmsClient,
  orderIds: string[],
): Promise<OmsReleasedProviderExceptionHoldRow[]> {
  if (!orderIds.length) return [];
  const result = await client
    .from("commerce_order_holds")
    .select("order_id, status, reason, created_by, released_by, metadata")
    .in("order_id", orderIds)
    .eq("status", "released")
    .eq("reason", "fulfillment_exception");
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS released provider-exception hold read failed");
  return (result.data ?? []) as OmsReleasedProviderExceptionHoldRow[];
}

function isOptionalProviderEvidenceTableError(error: { code?: string; message?: string; details?: string; hint?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703") return true;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return [
    "commerce_fulfillment_provider_attempts",
    "omnipack_dispatch_refs",
    "omnipack_status_evidence",
  ].some((name) => text.includes(name));
}
