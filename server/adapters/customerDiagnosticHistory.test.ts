import { describe, expect, it, vi } from "vitest";

import {
  CustomerDiagnosticConflictError,
  CustomerDiagnosticUnavailableError,
  type CustomerDiagnosticStoreInput,
} from "../domains/observability/customerDiagnosticHistory.js";
import { createCustomerDiagnosticHistoryPort } from "./customerDiagnosticHistory.js";

const at = "2026-09-12T10:00:00.000Z";
const segmentId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
const subjectId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const secondSegmentId = "55555555-5555-4555-8555-555555555555";

describe("customer diagnostic history RPC adapter", () => {
  it("maps a bounded append without passing a segment credential", async () => {
    const rpc = vi.fn(async () => ({ data: {
      outcome: "committed", credentialDisposition: "issued", deduplicated: false,
      segmentId, actionId: null,
    }, error: null }));
    const input: CustomerDiagnosticStoreInput = {
      contractVersion: "customer-diagnostic-ingest.v1",
      clientEventKey: eventId,
      action: "entry_boot", phase: "settled", code: "failed",
      presentedCredentialHash: null, issuedCredentialHash: "a".repeat(64),
      principalId: operatorId, subjectId, ingestRequestId: "request:server",
      abuseKeyHash: "b".repeat(64), payloadFingerprint: "c".repeat(64),
    };
    await expect(createCustomerDiagnosticHistoryPort({ rpc }, 7).ingest(input))
      .resolves.toMatchObject({ outcome: "committed", segmentId });
    expect(rpc).toHaveBeenCalledWith("customer_diagnostic_ingest_v1", {
      p_presented_credential_hash: null, p_issued_credential_hash: "a".repeat(64),
      p_principal_id: operatorId, p_subject_id: subjectId, p_client_event_key: eventId,
      p_client_action_key: null, p_action: "entry_boot", p_phase: "settled", p_code: "failed",
      p_duration_ms: null, p_reported_request_id: null, p_ingest_request_id: "request:server",
      p_abuse_key_hash: "b".repeat(64), p_payload_fingerprint: "c".repeat(64), p_retention_days: 7,
    });
  });

  it("uses the additive v2 RPCs and preserves stored coverage on mixed reads", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { outcome: "committed", credentialDisposition: "issued", deduplicated: false, segmentId, actionId: null }, error: null })
      .mockResolvedValueOnce({ data: {
        contractVersion: "customer-diagnostic-history.v2", sourceHealth: { read: "available", delivery: "unknown" }, loss: { status: "unknown", reason: "browser_delivery_not_measurable" }, retainedFrom: at, truncated: false, nextCursor: null,
        groups: [{ coverageVersion: "purchase-auth-account.v1", action: "entry_boot", phase: "settled", code: "failed", eventCount: 1, actionCount: 0, segmentCount: 1 }, { coverageVersion: "purchase-auth-account.v2", action: "account_profile_mutation", phase: "attempted", code: "observed", eventCount: 1, actionCount: 1, segmentCount: 1 }], segments: [],
      }, error: null })
      .mockResolvedValueOnce({ data: {
        contractVersion: "customer-diagnostic-history.v2", sourceHealth: { read: "available", delivery: "unknown" }, loss: { status: "unknown", reason: "browser_delivery_not_measurable" }, segmentId, attribution: "anonymous", subjectId: null, predecessor: null, truncated: false, nextCursor: null,
        events: [{ eventId, actionId: null, coverageVersion: "purchase-auth-account.v1", action: "entry_boot", phase: "settled", code: "failed", durationMs: null, relatedRequestId: null, relatedRequestTrust: null, ingestRequestId: "request:server", receivedAt: at }],
      }, error: null });
    const port = createCustomerDiagnosticHistoryPort({ rpc }, 7);
    await port.ingest({ contractVersion: "customer-diagnostic-ingest.v1", coverageVersion: "purchase-auth-account.v2", clientEventKey: eventId, action: "entry_boot", phase: "settled", code: "failed", presentedCredentialHash: null, issuedCredentialHash: "a".repeat(64), principalId: null, subjectId: null, ingestRequestId: "request:server", abuseKeyHash: "b".repeat(64), payloadFingerprint: "c".repeat(64) });
    await expect(port.search({ contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at, windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 10 })).resolves.toMatchObject({ contractVersion: "customer-diagnostic-history.v2", groups: [{ coverageVersion: "purchase-auth-account.v1" }, { coverageVersion: "purchase-auth-account.v2" }] });
    await expect(port.readSegment({ contractVersion: "customer-diagnostic-history.v2", operatorId, segmentId, pageSize: 50 })).resolves.toMatchObject({ contractVersion: "customer-diagnostic-history.v2", events: [{ coverageVersion: "purchase-auth-account.v1" }] });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["customer_diagnostic_ingest_v2", "customer_diagnostic_search_v2", "customer_diagnostic_segment_v2"]);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_coverage_version: "purchase-auth-account.v2" });
  });

  it("parses bounded search and history results", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: {
        contractVersion: "customer-diagnostic-history.v1", coverageVersion: "purchase-auth-account.v1",
        sourceHealth: { read: "available", delivery: "unknown" },
        loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
        retainedFrom: at, truncated: false, nextCursor: null,
        groups: [{ action: "entry_boot", phase: "settled", code: "failed", eventCount: 1, actionCount: 0, segmentCount: 1 }],
        segments: [{ segmentId, attribution: "account_verified", subjectId, firstSeenAt: at, lastSeenAt: at, eventCount: 1, actionCount: 0 }],
      }, error: null })
      .mockResolvedValueOnce({ data: {
        contractVersion: "customer-diagnostic-history.v1", coverageVersion: "purchase-auth-account.v1",
        sourceHealth: { read: "available", delivery: "unknown" },
        loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
        segmentId, attribution: "account_verified", subjectId,
        predecessor: null, truncated: false, nextCursor: null,
        events: [{ eventId, actionId: null, action: "entry_boot", phase: "settled", code: "failed",
          durationMs: null, relatedRequestId: "request:browser", relatedRequestTrust: "browser_reported",
          ingestRequestId: "request:server", receivedAt: at }],
      }, error: null });
    const port = createCustomerDiagnosticHistoryPort({ rpc }, 7);
    await expect(port.search({ contractVersion: "customer-diagnostic-history.v1", operatorId, windowStart: at, windowEnd: "2026-09-12T11:00:00.000Z", subjectId, pageSize: 10 }))
      .resolves.toMatchObject({ contractVersion: "customer-diagnostic-history.v1", coverageVersion: "purchase-auth-account.v1", segments: [{ subjectId }] });
    await expect(port.readSegment({ contractVersion: "customer-diagnostic-history.v1", operatorId, segmentId, pageSize: 50 }))
      .resolves.toMatchObject({ contractVersion: "customer-diagnostic-history.v1", coverageVersion: "purchase-auth-account.v1", events: [{ relatedRequestTrust: "browser_reported" }] });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_operator_id: operatorId, p_subject_id: subjectId, p_retention_days: 7,
      p_from: at, p_to: "2026-09-12T11:00:00.000Z",
    });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_operator_id: operatorId, p_segment_id: segmentId, p_retention_days: 7 });
  });

  it("keeps browser delivery loss unknown when a successful search is empty", async () => {
    const rpc = vi.fn(async () => ({ data: {
      contractVersion: "customer-diagnostic-history.v1", coverageVersion: "purchase-auth-account.v1",
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      retainedFrom: null, truncated: false, nextCursor: null, groups: [], segments: [],
    }, error: null }));
    await expect(createCustomerDiagnosticHistoryPort({ rpc }, 7).search({
      contractVersion: "customer-diagnostic-history.v1", operatorId, windowStart: at, windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 10,
    })).resolves.toMatchObject({
      groups: [], segments: [], sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
    });
  });

  it("maps the v2 global overview with independent evidence and rate axes", async () => {
    const rpc = vi.fn(async () => ({ data: {
      contractVersion: "customer-diagnostic-history.v2",
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      windowCoverage: "partial", evidencePresence: "observed", retainedFrom: at,
      truncated: true, nextCursor: "10",
      groups: [{
        coverageVersion: "purchase-auth-account.v2", action: "account_refresh",
        rateApplicability: "applicable", attemptedActionCount: 2,
        terminalOutcomes: [
          { classification: "refresh_failed", actionCount: 1, exampleSegmentIds: [segmentId] },
          { classification: "observation_gap", actionCount: 1, exampleSegmentIds: [secondSegmentId] },
        ],
        staticLifecycle: [],
      }, {
        coverageVersion: "purchase-auth-account.v1", action: "auth_callback",
        rateApplicability: "not_applicable", attemptedActionCount: null,
        terminalOutcomes: [],
        staticLifecycle: [{ phase: "settled", code: "callback_expired", eventCount: 2, actionCount: null, exampleSegmentIds: [segmentId] }],
      }],
    }, error: null }));
    const port = createCustomerDiagnosticHistoryPort({ rpc }, 7);
    await expect(port.overview!({
      contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at,
      windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 5, cursor: "10",
    })).resolves.toMatchObject({
      windowCoverage: "partial", evidencePresence: "observed", truncated: true,
      groups: [
        { action: "account_refresh", attemptedActionCount: 2 },
        { action: "auth_callback", attemptedActionCount: null },
      ],
    });
    expect(rpc).toHaveBeenCalledWith("customer_diagnostic_overview_v2", {
      p_operator_id: operatorId, p_from: at, p_to: "2026-09-12T11:00:00.000Z",
      p_page_size: 5, p_cursor: "10", p_retention_days: 7,
    });
  });

  it("separates static lifecycle event rows from the distinct actions behind them", async () => {
    const base = {
      contractVersion: "customer-diagnostic-history.v2",
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      windowCoverage: "full", evidencePresence: "observed", retainedFrom: at,
      truncated: false, nextCursor: null,
    };
    const staticGroups = [{
      coverageVersion: "purchase-auth-account.v2", action: "payment_status",
      rateApplicability: "not_applicable", attemptedActionCount: null, terminalOutcomes: [],
      // A polled status carries an action id: four rows, one action.
      staticLifecycle: [{ phase: "settled", code: "unknown", eventCount: 4, actionCount: 1, exampleSegmentIds: [segmentId] }],
    }, {
      coverageVersion: "purchase-auth-account.v2", action: "entry_boot",
      rateApplicability: "not_applicable", attemptedActionCount: null, terminalOutcomes: [],
      // Entry observations carry no action id at all.
      staticLifecycle: [{ phase: "entered", code: "observed", eventCount: 2, actionCount: null, exampleSegmentIds: [segmentId, secondSegmentId] }],
    }];
    const input = {
      contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at,
      windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 5,
    } as const;
    const port = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: { ...base, groups: staticGroups }, error: null }) }, 7);
    await expect(port.overview(input)).resolves.toMatchObject({ groups: [
      { action: "payment_status", staticLifecycle: [{ eventCount: 4, actionCount: 1 }] },
      { action: "entry_boot", staticLifecycle: [{ eventCount: 2, actionCount: null }] },
    ] });
    const withoutActionCount = staticGroups.map((group) => ({
      ...group,
      staticLifecycle: group.staticLifecycle.map(({ actionCount: _actionCount, ...entry }) => entry),
    }));
    const missing = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: { ...base, groups: withoutActionCount }, error: null }) }, 7);
    await expect(missing.overview(input)).rejects.toThrow();
  });

  it("keeps observed evidence when an exhausted cursor has no groups on this page", async () => {
    const port = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: {
      contractVersion: "customer-diagnostic-history.v2",
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      windowCoverage: "full", evidencePresence: "observed", retainedFrom: at,
      truncated: false, nextCursor: null, groups: [],
    }, error: null }) }, 7);
    await expect(port.overview({
      contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at,
      windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 1, cursor: "100",
    })).resolves.toMatchObject({ evidencePresence: "observed", groups: [], nextCursor: null });
  });

  it("fails closed when overview axes or bounded examples are inconsistent", async () => {
    const malformed = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: {
      contractVersion: "customer-diagnostic-history.v2",
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      windowCoverage: "full", evidencePresence: "observed", retainedFrom: null,
      truncated: false, nextCursor: null,
      groups: [{
        coverageVersion: "purchase-auth-account.v2", action: "account_refresh",
        rateApplicability: "applicable", attemptedActionCount: null,
        terminalOutcomes: [{ classification: "refresh_failed", actionCount: 1,
          exampleSegmentIds: [segmentId, secondSegmentId, subjectId, operatorId] }],
        staticLifecycle: [],
      }],
    }, error: null }) }, 7);
    await expect(malformed.overview!({
      contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at,
      windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 1,
    })).rejects.toThrow();
  });

  it("enforces overview group lifecycle and distinct-action arithmetic", async () => {
    const base = {
      contractVersion: "customer-diagnostic-history.v2",
      sourceHealth: { read: "available", delivery: "unknown" },
      loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
      windowCoverage: "full", evidencePresence: "observed", retainedFrom: null,
      truncated: false, nextCursor: null,
    };
    const invalidGroups = [
      [{ coverageVersion: "purchase-auth-account.v2", action: "account_refresh", rateApplicability: "applicable", attemptedActionCount: 1,
        terminalOutcomes: [{ classification: "refresh_failed", actionCount: 1, exampleSegmentIds: [segmentId] }],
        staticLifecycle: [{ phase: "settled", code: "observed", eventCount: 1, actionCount: null, exampleSegmentIds: [segmentId] }] }],
      [{ coverageVersion: "purchase-auth-account.v1", action: "auth_callback", rateApplicability: "not_applicable", attemptedActionCount: null,
        terminalOutcomes: [{ classification: "failed", actionCount: 1, exampleSegmentIds: [segmentId] }], staticLifecycle: [] }],
      [{ coverageVersion: "purchase-auth-account.v2", action: "account_refresh", rateApplicability: "applicable", attemptedActionCount: 2,
        terminalOutcomes: [{ classification: "refresh_failed", actionCount: 1, exampleSegmentIds: [segmentId] },
          { classification: "terminalWithoutStart", actionCount: 1, exampleSegmentIds: [secondSegmentId] }], staticLifecycle: [] }],
    ];
    for (const groups of invalidGroups) {
      const port = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: { ...base, groups }, error: null }) }, 7);
      await expect(port.overview({
        contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at,
        windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 1,
      })).rejects.toThrow();
    }
    const emptyWithGroups = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: {
      ...base, evidencePresence: "empty", groups: [{
        coverageVersion: "purchase-auth-account.v2", action: "account_refresh", rateApplicability: "applicable", attemptedActionCount: 1,
        terminalOutcomes: [{ classification: "refresh_failed", actionCount: 1, exampleSegmentIds: [segmentId] }], staticLifecycle: [],
      }],
    }, error: null }) }, 7);
    await expect(emptyWithGroups.overview({
      contractVersion: "customer-diagnostic-history.v2", operatorId, windowStart: at,
      windowEnd: "2026-09-12T11:00:00.000Z", pageSize: 1,
    })).rejects.toThrow();
  });

  it("fails closed on malformed results and classifies replay conflicts", async () => {
    const malformed = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: {}, error: null }) }, 7);
    await expect(malformed.search({ contractVersion: "customer-diagnostic-history.v1", operatorId, windowStart: at, windowEnd: at, pageSize: 1 })).rejects.toThrow();
    const conflict = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: null, error: { message: "customer_diagnostic_event_conflict" } }) }, 7);
    await expect(conflict.ingest({} as CustomerDiagnosticStoreInput)).rejects.toBeInstanceOf(CustomerDiagnosticConflictError);
    const unavailable = createCustomerDiagnosticHistoryPort({ rpc: async () => ({ data: undefined, error: null }) }, 7);
    await expect(unavailable.prune(100)).rejects.toBeInstanceOf(CustomerDiagnosticUnavailableError);
  });
});
