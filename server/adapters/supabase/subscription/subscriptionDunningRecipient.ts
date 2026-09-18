import type { DunningRecipientPort } from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";
import {
  createClientsRecipientPort,
  type ClientsRecipientSupabaseClient,
} from "./clientsRecipient.js";

export function createSupabaseSubscriptionDunningRecipientPort(
  client: ClientsRecipientSupabaseClient,
): DunningRecipientPort {
  return createClientsRecipientPort(client, { errorPrefix: "dunning_recipient_read_failed" });
}
