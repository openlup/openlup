import type { OmsInboundProviderEventRow } from "../../../../../src/domains/commerce/omsFulfillmentDebug.js";
import type { OmsOmnipackDispatchRefRow } from "../../../../../src/domains/commerce/omsFulfillmentSummary.js";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import type { OmsOrderRow } from "../../../../../src/domains/commerce/omsReadModel.js";
import { distinctIds, type CommerceOmsClient } from "./types.js";

const INBOUND_EVENT_COLUMNS = "id, provider, provider_event_id, event_type, processing_status, payload, error, created_at, processed_at";

export async function readOmnipackInboundEvents(
  client: CommerceOmsClient,
  input: { order: OmsOrderRow; dispatchRefs: OmsOmnipackDispatchRefRow[] },
): Promise<OmsInboundProviderEventRow[]> {
  const needles = distinctIds([
    input.order.order_number,
    input.order.id,
    ...input.dispatchRefs.map((row) => row.provider_order_id ?? null),
  ]);
  if (!needles.length) return [];
  const result = await client
    .from("inbound_provider_events")
    .select(INBOUND_EVENT_COLUMNS)
    .eq("provider", "omnipack")
    .order("created_at", { ascending: false })
    .range(0, 49);
  if (isOptionalInboundEventError(result.error)) return [];
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS OmniPack inbound events read failed");
  return ((result.data ?? []) as OmsInboundProviderEventRow[]).filter((row) => matchesNeedle(row, needles));
}

function matchesNeedle(row: OmsInboundProviderEventRow, needles: string[]): boolean {
  const haystack = JSON.stringify({
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    payload: row.payload,
    error: row.error,
  });
  return needles.some((needle) => haystack.includes(needle));
}

function isOptionalInboundEventError(error: { code?: string; message?: string; details?: string; hint?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703") return true;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return text.includes("inbound_provider_events");
}
