import { describe, expect, it } from "vitest";
import {
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1,
  CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2,
  customerDiagnosticHistoryContractVersionSchema,
  customerDiagnosticIngestRequestSchema as ingest,
  customerDiagnosticLookupSchema as lookup,
} from "./customerJourneyDiagnostics.js";

const event = {
  contractVersion: "customer-diagnostic-ingest.v1", clientEventKey: "11111111-1111-4111-8111-111111111111",
  clientActionKey: "22222222-2222-4222-8222-222222222222", action: "account_mutation", phase: "settled", code: "succeeded",
};
describe("closed customer diagnostics contract", () => {
  it("keeps work success separate from refresh failure", () => {
    expect(ingest.safeParse(event).success).toBe(true);
    expect(ingest.safeParse({ ...event, action: "account_refresh", phase: "refresh_started", code: "observed" }).success).toBe(true);
    expect(ingest.safeParse({ ...event, action: "account_refresh", phase: "refresh_settled", code: "refresh_failed" }).success).toBe(true);
    expect(ingest.safeParse({ ...event, action: "account_refresh", phase: "settled", code: "refresh_failed" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, code: "refresh_failed" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, clientActionKey: undefined }).success).toBe(false);
  });
  it("keeps the transport at v1 while dispatching only an explicit v2 coverage value", () => {
    expect(ingest.safeParse(event).success).toBe(true);
    expect(ingest.safeParse({ ...event, coverageVersion: "purchase-auth-account.v2" }).success).toBe(true);
    expect(ingest.safeParse({ ...event, coverageVersion: "purchase-auth-account.v1" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, coverageVersion: "unknown.v2" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, action: "auth_callback", phase: "settled", code: "callback_expired" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, action: "configurator_gate", phase: "attempted", code: "observed" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, code: "validation_blocked" }).success).toBe(false);
    expect(ingest.safeParse({ ...event, coverageVersion: "purchase-auth-account.v2", action: "auth_callback", phase: "settled", code: "callback_expired", clientActionKey: undefined }).success).toBe(true);
    expect(ingest.safeParse({ ...event, coverageVersion: "purchase-auth-account.v2", action: "entry_hydration", phase: "settled", code: "succeeded", clientActionKey: undefined }).success).toBe(false);
    expect(ingest.safeParse({ ...event, action: "entry_hydration", phase: "settled", code: "succeeded", clientActionKey: undefined }).success).toBe(true);
  });
  it.each(["subjectId", "email", "url", "stack", "metadata", "accessToken"])("rejects injected %s", (key) => {
    expect(ingest.safeParse({ ...event, [key]: "secret" }).success).toBe(false);
  });
  it("rejects unknown outcomes, invalid references, oversized durations and credentials", () => {
    for (const invalid of [{ code: "bank_declined" }, { relatedRequestId: "?token=secret" }, { durationMs: 600001 }, { segmentCredential: "caller-choice" }]) {
      expect(ingest.safeParse({ ...event, ...invalid }).success).toBe(false);
    }
  });
  it("bounds privileged anonymous search and forbids free text", () => {
    const query = { mode: "search", from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z" };
    expect(lookup.safeParse(query).success).toBe(true);
    for (const invalid of [{ to: "2026-09-20T00:00:00Z" }, { to: query.from }, { pageSize: 26 }, { email: "person@example.test" }]) {
      expect(lookup.safeParse({ ...query, ...invalid }).success).toBe(false);
    }
    expect(lookup.safeParse({ mode: "history", segmentId: event.clientEventKey, pageSize: 101 }).success).toBe(false);
    const overview = { mode: "overview", from: query.from, to: query.to };
    expect(lookup.safeParse(overview).success).toBe(true);
    for (const invalid of [{ action: "account_refresh" }, { subjectId: event.clientEventKey }, { pageSize: 26 }, { cursor: "" }, { cursor: "opaque" }, { cursor: "12345678" }]) {
      expect(lookup.safeParse({ ...overview, ...invalid }).success).toBe(false);
    }
    expect(lookup.safeParse({ ...query, cursor: "opaque" }).success).toBe(true);
  });
  it("keeps retained v1 reads distinct from the mixed per-event v2 response", () => {
    expect(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION).toBe("customer-diagnostic-history.v1");
    expect(customerDiagnosticHistoryContractVersionSchema.safeParse(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V1).success).toBe(true);
    expect(customerDiagnosticHistoryContractVersionSchema.safeParse(CUSTOMER_DIAGNOSTIC_HISTORY_CONTRACT_VERSION_V2).success).toBe(true);
    expect(customerDiagnosticHistoryContractVersionSchema.safeParse("customer-diagnostic-history.v3").success).toBe(false);
  });
});
