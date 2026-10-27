import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import type { AdminPipelineReadPort } from "../../src/operations/contracts/index.js";
import {
  createAdminPipelineReadHandler,
} from "../../src/operations/server/adminPipelineHandlers.js";
import type { OperationsAuthorizationResult } from "../../src/operations/contracts/index.js";

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
    await createAdminPipelineReadHandler({
      pipelinePort: createPort(),
      authorizeAdmin: authorize({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
    })(request("GET"), forbidden);

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
    await createAdminPipelineReadHandler({
      pipelinePort: createPort(new Error("Function unavailable")),
      authorizeAdmin: authorize(),
    })(request("GET"), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function request(method: string, query = {}, body?: unknown): HttpRequest {
  return { method, query, body } as unknown as HttpRequest;
}

function authorize(
  result: OperationsAuthorizationResult = { ok: true },
): () => Promise<OperationsAuthorizationResult> {
  return vi.fn().mockResolvedValue(result);
}

function createPort(result?: unknown): AdminPipelineReadPort {
  return {
    readPipeline: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? pipelineResponse();
    }),

  };
}

function createResponse(): HttpResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as HttpResponse;

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
