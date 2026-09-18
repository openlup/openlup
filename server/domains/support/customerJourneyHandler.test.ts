import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

import { SUPPORT_CUSTOMER_JOURNEY_CONTRACT_VERSION } from "../../../src/domains/support/customerJourneyContracts.js";
import { createCustomerJourneySnapshotHandler, type CustomerJourneySnapshotPort } from "./customerJourneySnapshot.js";

const clientId = "11111111-1111-4111-8111-111111111111";

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function request(query: Record<string, unknown>): VercelRequest {
  return { method: "GET", query, headers: {} } as unknown as VercelRequest;
}

describe("customer journey support handler", () => {
  it("returns a sanitized support envelope and audits the matched client", async () => {
    const audit = vi.fn(async () => ({ data: null, error: null }));
    const snapshotPort: CustomerJourneySnapshotPort = {
      search: vi.fn(),
      snapshot: vi.fn(async () => ({
        contractVersion: SUPPORT_CUSTOMER_JOURNEY_CONTRACT_VERSION,
        lookup: { query: "OPENLUP-1", matchedBy: "orderNumber", confidence: "exact", warnings: [] },
        customer: { clientId, email: "a@example.com", name: "A Buyer", authUserLinked: true, lifecycleStage: "customer" },
        firstTrace: { kind: "identity", source: "clients", occurredAt: "2026-07-13T09:00:00.000Z", sourceRef: { clientId } },
        checkout: { orderDrafts: [], recoveryTokens: [], abandonedCartEvents: [] },
        payment: { status: "succeeded", intents: [], attempts: [], transitions: [], providerRefs: [] },
        orders: [],
        subscriptions: [],
        timeline: [],
        gaps: [],
        nextChecks: ["Read only"],
      })),
    };
    const handler = createCustomerJourneySnapshotHandler({
      snapshotPort,
      authorizeAdmin: async () => ({ ok: true, userId: "actor-1", isMachineActor: true }),
      governance: {
        flagEnabled: true,
        auditClient: { rpc: audit },
      },
    });
    const res = response();

    await handler(request({ orderNumber: "OPENLUP-1" }), res);

    expect(snapshotPort.snapshot).toHaveBeenCalledWith({ orderNumber: "OPENLUP-1", pageSize: 10 });
    expect(audit).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ contractVersion: SUPPORT_CUSTOMER_JOURNEY_CONTRACT_VERSION }),
    }));
  });

  it("blocks machine reads when the customer-read feature flag is disabled", async () => {
    const snapshotPort: CustomerJourneySnapshotPort = { search: vi.fn(), snapshot: vi.fn() };
    const handler = createCustomerJourneySnapshotHandler({
      snapshotPort,
      authorizeAdmin: async () => ({ ok: true, userId: "actor-1", isMachineActor: true }),
      governance: {
        flagEnabled: false,
        auditClient: { rpc: vi.fn(async () => ({ data: null, error: null })) },
      },
    });
    const res = response();

    await handler(request({ orderNumber: "OPENLUP-1" }), res);

    expect(snapshotPort.snapshot).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        details: { reason: "feature_flag_disabled", featureFlag: "COMMERCE_AGENT_CUSTOMER_READ_ENABLED" },
      }),
    }));
  });
});
