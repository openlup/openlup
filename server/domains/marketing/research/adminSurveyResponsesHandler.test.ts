import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import type { MarketingResearchSurveyResponsesReadPort } from "../../../../src/domains/marketing/research/ports.js";
import { createAdminSurveyResponsesHandler } from "./adminSurveyResponsesHandler.js";

describe("marketing research admin survey responses handler", () => {
  it("returns survey rows through the BFF envelope", async () => {
    const readPort = createReadPort();
    const res = createResponse();

    await createHandler({ readPort })(
      request("GET", { surveyType: "producer", limit: "50" }),
      res,
    );

    expect(readPort.getAdminSurveyResponses).toHaveBeenCalledWith({
      surveyType: "producer",
      page: 0,
      pageSize: 50,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        rows: [row()],
        totalCount: 1,
        page: 0,
        pageSize: 50,
      },
    });
  });

  it("rejects invalid requests, unsupported methods, and missing admin sessions", async () => {
    const invalid = createResponse();
    await createHandler({ readPort: createReadPort() })(
      request("GET", { surveyType: "partner" }),
      invalid,
    );

    const method = createResponse();
    await createHandler({ readPort: createReadPort() })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({ readPort: createReadPort(), authorized: false })(
      request("GET", { surveyType: "producer" }),
      unauthorized,
    );

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
  });

  it("maps invalid output, upstream failures, and authorization failures", async () => {
    const invalid = createResponse();
    await createHandler({
      readPort: createReadPort({ result: { rows: [{ ...row(), response_data: Number.NaN }] } }),
    })(request("GET", { surveyType: "producer" }), invalid);

    const failed = createResponse();
    await createHandler({
      readPort: createReadPort({ result: new Error("Supabase unavailable") }),
    })(request("GET", { surveyType: "consumer" }), failed);

    const authFailed = createResponse();
    await createHandler({
      readPort: createReadPort(),
      authError: new Error("Auth failed"),
    })(request("GET", { surveyType: "producer" }), authFailed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(authFailed.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  readPort,
  authorized = true,
  authError,
}: {
  readPort: MarketingResearchSurveyResponsesReadPort;
  authorized?: boolean;
  authError?: Error;
}) {
  return createAdminSurveyResponsesHandler({
    readPort,
    authorizeAdmin: vi.fn().mockImplementation(async () => {
      if (authError) throw authError;
      return authorized;
    }),
  });
}

function request(
  method: string,
  query: Record<string, string | string[] | undefined> = {},
): VercelRequest {
  return { method, body: {}, query } as unknown as VercelRequest;
}

function createReadPort({ result }: { result?: unknown } = {}): MarketingResearchSurveyResponsesReadPort {
  return {
    getAdminSurveyResponses: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? {
        rows: [row()],
        totalCount: 1,
        page: 0,
        pageSize: 50,
      };
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

function row() {
  return {
    id: "row-1",
    created_at: "2026-05-14T07:00:00.000Z",
    response_data: { screen1_role: "Founder" },
  };
}
