import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { FulfillmentOmnipackOperationalProofPort } from "../../../src/domains/fulfillment/ports.js";
import { createOmnipackOperationalProofHandler } from "./omnipackOperationalProofHandler.js";

describe("omnipack operational proof handler", () => {
  it("returns operational proof through the shared admin envelope", async () => {
    const port = createPort(response());
    const res = createResponse();

    await createOmnipackOperationalProofHandler({
      proofPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })(request("GET"), res);

    expect(port.getOmnipackOperationalProof).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: response() });
  });

  it("rejects unsupported methods and missing admin sessions before reading proof", async () => {
    const method = createResponse();
    await createHandler({ port: createPort(response()) })(request("POST"), method);

    const unauthorizedPort = createPort(response());
    const unauthorized = createResponse();
    await createHandler({ port: unauthorizedPort, authorized: false })(request("GET"), unauthorized);

    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(unauthorizedPort.getOmnipackOperationalProof).not.toHaveBeenCalled();
  });

  it("maps invalid port responses and upstream failures", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ ...response(), generatedAt: "bad-date" }) })(request("GET"), invalid);

    const failed = createResponse();
    await createHandler({ port: createPort(new Error("Supabase down")) })(request("GET"), failed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({ port, authorized = true }: {
  port: FulfillmentOmnipackOperationalProofPort;
  authorized?: boolean;
}) {
  return createOmnipackOperationalProofHandler({
    proofPort: port,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function createPort(result: unknown): FulfillmentOmnipackOperationalProofPort {
  return {
    getOmnipackOperationalProof: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function request(method: string): VercelRequest {
  return { method, query: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function response() {
  return {
    generatedAt: "2026-06-30T10:00:00+00:00",
    ok: true,
    blockers: [],
    webhooks: { routes: [], failedInboundEvents: 0, ignoredInboundEvents: 0 },
    reconciliation: { lastReconciledAt: null, statusEvidenceCount: 0, quarantineCount: 0 },
    stockSync: {
      status: "succeeded",
      lastStockSyncedAt: "2026-06-30T09:55:00+00:00",
      staleProviderStockSkuCount: 0,
      providerLocalMismatchSkuCount: 0,
    },
    fulfillment: { consumedReservationGapCount: 0, sampleFulfillmentOrderIds: [] },
  };
}
