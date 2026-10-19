export { EmailDeliveryTimelineError, outboxDeliveryDedupeKey, commerceOrderAggregateId, statusFromSendOutcome } from "@openlup/platform/communications";
export type { EmailDeliveryTimelineStatus, EmailDeliveryPurpose, EmailDeliveryTimelineClient, EmailDeliveryTimelineInput, EmailDeliveryTimelineOptions } from "@openlup/platform/communications";
import { recordEmailDeliveryTimeline as record } from "@openlup/platform/communications";
import type { EmailDeliveryTimelineClient, EmailDeliveryTimelineInput, EmailDeliveryTimelineOptions } from "@openlup/platform/communications";
export function recordEmailDeliveryTimeline(client: EmailDeliveryTimelineClient, input: EmailDeliveryTimelineInput, options: EmailDeliveryTimelineOptions = {}): Promise<string | null> {
  return record(client, input, options, "resend");
}
