/** Native capability bindings; host authentication, neutral observations and membership I/O remain injected. */
export {
  createPostgresDeliveryReconciliationPort,
  createPostgresCommunicationSyncStore,
  createPostgresNotificationRecipientsPort,
  createPostgresConsentEvaluator,
} from "@openlup/platform/communications";
