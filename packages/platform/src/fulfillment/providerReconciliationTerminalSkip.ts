import { FULFILLMENT_STATUS_MAP } from "./statusMap.js";
const OFF_TRACK_FULFILLMENT_STATUSES: ReadonlySet<string> = new Set(
  FULFILLMENT_STATUS_MAP.stages.filter(stage => !stage.onTrack).flatMap(stage => stage.omsFulfillmentStatus),
);
/** Off-track rows still write evidence; acceptance and all effects must skip. */
export function isOffTrackFulfillmentStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && OFF_TRACK_FULFILLMENT_STATUSES.has(status);
}
