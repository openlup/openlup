import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminPipelinePort } from "../../../src/domains/platform/ports.js";
import {
  createAdminPipelineDhlTrackingRefreshHandler,
  createAdminPipelineReadHandler,
} from "./adminPipelineHandlers.js";
import type { PlatformAdminAuthorizationResult } from "./adminAuth.js";

describe("admin pipeline handlers", () => {
  it("reads admin pipeline data through the shared BFF envelope", async () => {
    const pipelinePort = createPort();
    const res = createResponse();

    await createAdminPipelineReadHandler({
      pipelinePort,
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(pipelinePort.readPipeline).toHaveBeenCalledWith({});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: pipelineResponse(),
    });
  });

  it("refreshes DHL tracking through the shared BFF envelope", async () => {
    const pipelinePort = createPort();
    const res = createResponse();

    await createAdminPipelineDhlTrackingRefreshHandler({
      pipelinePort,
      authorizeAdmin: authorize(),
    })(request("POST", {}, {}), res);

    expect(pipelinePort.refreshDhlTracking).toHaveBeenCalledWith({});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { checked: 3, updated: 2 },
    });
  });

  it("rejects unsupported methods and non-admin users", async () => {
    const method = createResponse();
    await createAdminPipelineReadHandler({
      pipelinePort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST"), method);

    const unauthorized = createResponse();
    await createAdminPipelineReadHandler({
      pipelinePort: createPort(),
      authorizeAdmin: authorize({ ok: false, code: "UNAUTHORIZED", message: "Admin session required" }),
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createAdminPipelineDhlTrackingRefreshHandler({
      pipelinePort: createPort(),
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("POST", {}, {}), forbidden);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps authorization, invalid output, and upstream failures", async () => {
    const authFailed = createResponse();
    await createAdminPipelineReadHandler({
      pipelinePort: createPort(),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("Auth unavailable")),
    })(request("GET"), authFailed);

    const invalid = createResponse();
    await createAdminPipelineReadHandler({
      pipelinePort: createPort({ ...pipelineResponse(), emailSendCount: -1 }),
      authorizeAdmin: authorize(),
    })(request("GET"), invalid);

    const failed = createResponse();
    await createAdminPipelineDhlTrackingRefreshHandler({
      pipelinePort: createPort(new Error("Function unavailable")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, {}), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function request(method: string, query = {}, body?: unknown): VercelRequest {
  return { method, query, body } as unknown as VercelRequest;
}

function authorize(
  result: PlatformAdminAuthorizationResult = { ok: true },
): () => Promise<PlatformAdminAuthorizationResult> {
  return vi.fn().mockResolvedValue(result);
}

function createPort(result?: unknown): AdminPipelinePort {
  return {
    readPipeline: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? pipelineResponse();
    }),
    refreshDhlTracking: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? { checked: 3, updated: 2 };
    }),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function pipelineResponse() {
  return {
    testers: [
      {
        id: "tester-1",
        status: "packing",
        email_sequence_step: 2,
        email_sequence_paused: false,
      },
    ],
    templates: [{ id: "tpl-1", name: "Reminder", sequence_order: 2 }],
    emailSendCount: 10,
    emailEvents: [{ event_type: "opened" }],
  };
}
