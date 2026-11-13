import type { EcommerceEventExportRequest } from "../../../src/communications/contracts/ecommerceEvents.js";
import { fixture } from "./harness.js";

export const clientId = "e4000000-0000-4000-8000-000000000001", orderId = "e4000000-0000-4000-8000-000000000002";
const intentId = "e4000000-0000-4000-8000-000000000003";
const sourceTypes = ["order.paid", "order.refund_status_changed", "checkout.recovery_qualified", "subscription.created", "subscription.paused", "subscription.resumed", "subscription.cancelled"] as const;
export function eventFixture() {
  const h = fixture(), binding = { ...h.config.binding, mappingVersion: "ecommerce-v1" };
  h.config.binding = binding; h.state.subject.binding = binding;
  h.config.resolveCredential = () => ({ binding, key: "synthetic-key" });
  for (const [key, value] of h.authorizations) h.authorizations.set(key, { ...value, binding });
  for (const [key, value] of h.localEvidence) h.localEvidence.set(key, { ...value, binding });
  h.config.verification = { ...h.config.verification!, binding };
  const request: EcommerceEventExportRequest = { binding, subjectReference: "subject:1", profileId: "owned_1", generation: 1,
    authorityReference: "authority:paid:1", classification: "live", currencyExponent: 2, currencyExponentSource: "offline:currency-table-v1",
    event: { schemaVersion: 1, sourceId: "paid:1", sourceType: "order.paid", occurredAt: new Date(1).toISOString(), subject: { clientId },
      data: { orderId, settlementIntentId: intentId, purchaseKind: "one_time", amountMinor: 12345, currency: "USD", lines: [{ sku: "ITEM-1", quantity: 1, amountMinor: 12345 }] } } };
  const state = { current: true, retained: structuredClone(request) };
  h.config.events = { liveSinceMs: 0, authorize: candidate => state.current && JSON.stringify(candidate) === JSON.stringify(state.retained),
    verification: { binding, revision: "2026-07-15", evidenceReference: "offline:synthetic-not-TEST", scopes: ["events:write"],
      sourceTypes, accountEffectsVerified: true, messageOwnershipVerified: true } };
  const approve = (value: EcommerceEventExportRequest) => { state.retained = structuredClone(value); };
  return { ...h, binding, request, authority: state, approve, provider: h.rebuild() };
}
