import { expect, it } from "vitest";
import { createPostgresDeliveryReconciliationPort, createPostgresCommunicationSyncStore, createPostgresNotificationRecipientsPort, createPostgresConsentEvaluator } from "./communicationsLifecycle.js";
it("binds all four native factories through the public server entry", () => {
  expect([createPostgresDeliveryReconciliationPort,createPostgresCommunicationSyncStore,createPostgresNotificationRecipientsPort,createPostgresConsentEvaluator].every(value => typeof value === "function")).toBe(true);
});
