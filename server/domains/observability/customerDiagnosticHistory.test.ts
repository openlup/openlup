import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createCustomerDiagnosticHistoryPort } from "../../adapters/customerDiagnosticHistory.js";
import type { CustomerDiagnosticIngestRequest } from "../../../src/domains/observability/customerJourneyDiagnostics.js";
import {
  CustomerDiagnosticUnavailableError,
  ingestCustomerDiagnostic,
  type CustomerDiagnosticHistoryPort,
  type CustomerDiagnosticStoreInput,
} from "./customerDiagnosticHistory.js";

const credential = "A".repeat(43);
const nextCredential = "B".repeat(43);
const request: CustomerDiagnosticIngestRequest = {
  contractVersion: "customer-diagnostic-ingest.v1",
  clientEventKey: "11111111-1111-4111-8111-111111111111",
  segmentCredential: credential,
  action: "auth_bootstrap",
  phase: "settled",
  code: "timeout",
  durationMs: 321,
  relatedRequestId: "request:browser-reported",
};
const context = {
  principalId: "22222222-2222-4222-8222-222222222222",
  subjectId: "33333333-3333-4333-8333-333333333333",
  ingestRequestId: "request:trusted-server",
  abuseKeyHash: "c".repeat(64),
};
const journeySegmentId = "11111111-1111-4111-8111-111111111111";
const mutationActionId = "22222222-2222-4222-8222-222222222222";
const refreshActionId = "33333333-3333-4333-8333-333333333333";
const mutationEventId = "44444444-4444-4444-8444-444444444444";
const refreshEventId = "55555555-5555-4555-8555-555555555555";
const customerSubjectId = "66666666-6666-4666-8666-666666666666";
const operatorId = "77777777-7777-4777-8777-777777777777";
const windowStart = "2026-09-12T10:00:00.000Z";
const windowEnd = "2026-09-12T11:00:00.000Z";
const overviewInput = {
  contractVersion: "customer-diagnostic-history.v2",
  operatorId, windowStart, windowEnd, pageSize: 10,
} as const;

describe("customer diagnostic history domain", () => {
  it("keeps the legacy v1 fingerprint byte-compatible without passing the raw credential", async () => {
    const port = fakePort({ outcome: "committed", credentialDisposition: "reused", deduplicated: false });
    await expect(ingestCustomerDiagnostic(port, request, context, { createCredential: () => nextCredential }))
      .resolves.toEqual({ outcome: "committed", segmentCredential: credential, deduplicated: false });

    expect(port.ingest).toHaveBeenCalledWith(expect.objectContaining({
      presentedCredentialHash: sha256(credential),
      issuedCredentialHash: sha256(nextCredential),
      principalId: context.principalId,
      subjectId: context.subjectId,
      ingestRequestId: context.ingestRequestId,
    }));
    const stored = vi.mocked(port.ingest).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty("segmentCredential");
    expect(JSON.stringify(stored)).not.toContain(credential);
    expect(stored.payloadFingerprint).toBe(sha256(JSON.stringify({
      clientActionKey: null,
      action: "auth_bootstrap",
      phase: "settled",
      code: "timeout",
      durationMs: 321,
      relatedRequestId: "request:browser-reported",
    })));
  });

  it("binds coverage version into the immutable replay fingerprint", async () => {
    const port = fakePort({ outcome: "committed", credentialDisposition: "reused", deduplicated: false });
    await ingestCustomerDiagnostic(port, { ...request, coverageVersion: "purchase-auth-account.v2" }, context);
    const stored = vi.mocked(port.ingest).mock.calls[0]?.[0] as CustomerDiagnosticStoreInput;
    expect(stored.payloadFingerprint).toBe(sha256(JSON.stringify({
      coverageVersion: "purchase-auth-account.v2", clientActionKey: null, action: "auth_bootstrap", phase: "settled",
      code: "timeout", durationMs: 321, relatedRequestId: "request:browser-reported",
    })));
  });

  it("returns a new server credential only after a committed append", async () => {
    const port = fakePort({ outcome: "committed", credentialDisposition: "issued", deduplicated: true });
    await expect(ingestCustomerDiagnostic(port, { ...request, segmentCredential: undefined }, context,
      { createCredential: () => nextCredential }))
      .resolves.toEqual({ outcome: "committed", segmentCredential: nextCredential, deduplicated: true });
  });

  it("hands back the issued credential when a committed reuse rotated the segment's own", async () => {
    const port = fakePort({ outcome: "committed", credentialDisposition: "rotated", deduplicated: false });
    await expect(ingestCustomerDiagnostic(port, request, context, { createCredential: () => nextCredential }))
      .resolves.toEqual({ outcome: "committed", segmentCredential: nextCredential, deduplicated: false });
    // The disposition has to survive the RPC boundary too: a rotation the adapter
    // rejected would strand the tab holding a credential the segment no longer has.
    const rotating = createCustomerDiagnosticHistoryPort({
      rpc: async () => ({
        data: {
          outcome: "committed", credentialDisposition: "rotated", deduplicated: false,
          segmentId: journeySegmentId, actionId: null,
        },
        error: null,
      }),
    }, 7);
    await expect(ingestCustomerDiagnostic(rotating, { ...request, coverageVersion: "purchase-auth-account.v2" },
      context, { createCredential: () => nextCredential }))
      .resolves.toEqual({ outcome: "committed", segmentCredential: nextCredential, deduplicated: false });
  });

  it("does not expose a credential for rejected admission or incomplete persistence results", async () => {
    await expect(ingestCustomerDiagnostic(fakePort({ outcome: "rate_limited" }), request, context))
      .resolves.toEqual({ outcome: "rate_limited" });
    await expect(ingestCustomerDiagnostic(fakePort({ outcome: "committed", credentialDisposition: "reused" }), request, context))
      .rejects.toBeInstanceOf(CustomerDiagnosticUnavailableError);
  });

  it("follows overview evidence through a classified segment and canonical evidence", async () => {
    const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
      data: name === "customer_diagnostic_overview_v2" ? overviewPayload() : segmentPayload(),
      error: null,
    }));
    const port = createCustomerDiagnosticHistoryPort({ rpc }, 7);
    const readCanonicalEvidence = vi.fn(async (actionId: string | null) => actionId === mutationActionId
      ? { disposition: "committed", actionId }
      : null);

    const overview = await port.overview(overviewInput);
    const refresh = overview.groups.find((group) => group.action === "account_refresh")!;
    const recurringFailure = refresh.terminalOutcomes.find((outcome) => outcome.classification === "refresh_failed")!;
    const segment = await port.readSegment({
      contractVersion: "customer-diagnostic-history.v2", operatorId,
      segmentId: recurringFailure.exampleSegmentIds[0]!, pageSize: 50,
    });
    if (segment === null || segment.contractVersion !== "customer-diagnostic-history.v2") {
      throw new Error("expected a v2 segment for the classified overview example");
    }
    const mutation = segment.events.find((event) => event.action === "account_profile_mutation")!;
    const refreshEvent = segment.events.find((event) => event.action === "account_refresh")!;
    const canonicalEvidence = await readCanonicalEvidence(mutation.actionId);
    expect({
      actionable: refresh.rateApplicability === "applicable" && recurringFailure.actionCount >= 2,
      recurringExample: recurringFailure.exampleSegmentIds,
      mutationCommit: canonicalEvidence?.disposition,
      separateRefreshAction: refreshEvent.actionId !== mutation.actionId && refreshEvent.code,
      unknownDelivery: [overview.sourceHealth.delivery, segment.sourceHealth.delivery],
      unknownLoss: [overview.loss.status, segment.loss.status],
    }).toEqual({
      actionable: true, recurringExample: [journeySegmentId], mutationCommit: "committed",
      separateRefreshAction: "refresh_failed", unknownDelivery: ["unknown", "unknown"], unknownLoss: ["unknown", "unknown"],
    });
    // The recurring failure is reachable without knowing a customer: the overview
    // read carries no subject, and only the classified example opens a segment.
    expect(rpc.mock.calls.map(([name]) => name))
      .toEqual(["customer_diagnostic_overview_v2", "customer_diagnostic_segment_v2"]);
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_subject_id");
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).not.toContain(customerSubjectId);
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_segment_id: journeySegmentId, p_operator_id: operatorId });
    expect(readCanonicalEvidence).toHaveBeenCalledWith(mutationActionId);
    // Polled payment status stays a static lifecycle: three rows, one action.
    expect(overview.groups.find((group) => group.action === "payment_status")?.staticLifecycle)
      .toEqual([{ phase: "settled", code: "unknown", eventCount: 3, actionCount: 1, exampleSegmentIds: [journeySegmentId] }]);
  });

  it("refuses an overview whose attempted actions exceed its classified terminals", async () => {
    const port = createCustomerDiagnosticHistoryPort({
      rpc: async () => ({ data: overviewPayload(2), error: null }),
    }, 7);
    await expect(port.overview(overviewInput)).rejects.toThrow(/terminal outcomes/);
  });
});

/** Complete, strict-valid `customer_diagnostic_overview_v2` payload. */
function overviewPayload(refreshFailedActionCount = 3): unknown {
  return {
    contractVersion: "customer-diagnostic-history.v2",
    sourceHealth: { read: "available", delivery: "unknown" },
    loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
    windowCoverage: "full", evidencePresence: "observed", retainedFrom: windowStart,
    truncated: false, nextCursor: null,
    groups: [{
      coverageVersion: "purchase-auth-account.v2", action: "account_profile_mutation",
      rateApplicability: "applicable", attemptedActionCount: 1,
      terminalOutcomes: [{ classification: "succeeded", actionCount: 1, exampleSegmentIds: [journeySegmentId] }],
      staticLifecycle: [],
    }, {
      coverageVersion: "purchase-auth-account.v2", action: "account_refresh",
      rateApplicability: "applicable", attemptedActionCount: 3,
      terminalOutcomes: [{ classification: "refresh_failed", actionCount: refreshFailedActionCount, exampleSegmentIds: [journeySegmentId] }],
      staticLifecycle: [],
    }, {
      coverageVersion: "purchase-auth-account.v2", action: "payment_status",
      rateApplicability: "not_applicable", attemptedActionCount: null, terminalOutcomes: [],
      staticLifecycle: [{ phase: "settled", code: "unknown", eventCount: 3, actionCount: 1, exampleSegmentIds: [journeySegmentId] }],
    }],
  };
}

/** Complete, strict-valid `customer_diagnostic_segment_v2` payload. */
function segmentPayload(): unknown {
  return {
    contractVersion: "customer-diagnostic-history.v2",
    sourceHealth: { read: "available", delivery: "unknown" },
    loss: { status: "unknown", reason: "browser_delivery_not_measurable" },
    segmentId: journeySegmentId, attribution: "account_verified", subjectId: customerSubjectId,
    predecessor: null, truncated: false, nextCursor: null,
    events: [{
      coverageVersion: "purchase-auth-account.v2", eventId: mutationEventId, actionId: mutationActionId,
      action: "account_profile_mutation", phase: "settled", code: "succeeded", durationMs: 412,
      relatedRequestId: "request:browser-reported", relatedRequestTrust: "browser_reported",
      ingestRequestId: "request:trusted-server", receivedAt: windowStart,
    }, {
      coverageVersion: "purchase-auth-account.v2", eventId: refreshEventId, actionId: refreshActionId,
      action: "account_refresh", phase: "refresh_settled", code: "refresh_failed", durationMs: 1_200,
      relatedRequestId: null, relatedRequestTrust: null,
      ingestRequestId: "request:trusted-server", receivedAt: "2026-09-12T10:00:05.000Z",
    }],
  };
}

function fakePort(result: Awaited<ReturnType<CustomerDiagnosticHistoryPort["ingest"]>>): CustomerDiagnosticHistoryPort {
  return {
    ingest: vi.fn(async () => result),
    search: vi.fn(),
    readSegment: vi.fn(),
    prune: vi.fn(),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
