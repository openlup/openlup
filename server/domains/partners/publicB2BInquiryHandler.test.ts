import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { PartnersB2BInquirySubmitPort } from "../../../src/domains/partners/ports.js";
import { createPartnersPublicB2BInquirySubmitHandler } from "./publicB2BInquiryHandler.js";

describe("partners public B2B inquiry submit handler", () => {
  it("submits valid B2B inquiries through the port", async () => {
    const submitPort = createSubmitPort({ success: true, id: "inq-1", status: 200 });
    const res = createResponse();

    await createPartnersPublicB2BInquirySubmitHandler({ submitPort })(
      request("POST", validRequest()),
      res,
    );

    expect(submitPort.submitB2BInquiry).toHaveBeenCalledWith(validRequest(), {
      headers: expect.any(Headers),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { success: true, id: "inq-1" },
    });
  });

  it("rejects invalid requests and unsupported methods", async () => {
    const submitPort = createSubmitPort({ success: true });
    const invalid = createResponse();
    await createPartnersPublicB2BInquirySubmitHandler({ submitPort })(
      request("POST", { ...validRequest(), email: "not-email" }),
      invalid,
    );

    const method = createResponse();
    await createPartnersPublicB2BInquirySubmitHandler({ submitPort })(
      request("GET", undefined),
      method,
    );

    expect(submitPort.submitB2BInquiry).not.toHaveBeenCalled();
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(method.status).toHaveBeenCalledWith(405);
  });

  it("maps legacy rate-limit and validation failures into BFF errors", async () => {
    const rateLimited = createResponse();
    await createPartnersPublicB2BInquirySubmitHandler({
      submitPort: createSubmitPort({ success: false, error: "rate_limit", code: "rate_limit", status: 429 }),
    })(request("POST", validRequest()), rateLimited);

    const blockedEmail = createResponse();
    await createPartnersPublicB2BInquirySubmitHandler({
      submitPort: createSubmitPort({
        success: false,
        error: "blocked_email_domain",
        code: "validation_error",
        status: 400,
      }),
    })(request("POST", validRequest()), blockedEmail);

    expect(rateLimited.status).toHaveBeenCalledWith(429);
    expect(rateLimited.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many B2B inquiries",
        details: { reason: "rate_limit" },
      },
    });
    expect(blockedEmail.status).toHaveBeenCalledWith(400);
    expect(blockedEmail.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: "Invalid B2B inquiry request",
        details: { reason: "blocked_email_domain" },
      },
    });
  });

  it("maps invalid port output and upstream failures", async () => {
    const invalid = createResponse();
    await createPartnersPublicB2BInquirySubmitHandler({
      submitPort: createSubmitPort({ success: true, id: "" }),
    })(request("POST", validRequest()), invalid);

    const failed = createResponse();
    await createPartnersPublicB2BInquirySubmitHandler({
      submitPort: createSubmitPort(new Error("database unavailable")),
    })(request("POST", validRequest()), failed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("does not expose internal upstream configuration reasons publicly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = createResponse();

    await createPartnersPublicB2BInquirySubmitHandler({
      submitPort: createSubmitPort({
        success: false,
        error: "RESEND_API_KEY is required unless RESEND_PROVIDER_MODE=sandbox is set",
        code: "RESEND_API_KEY is required unless RESEND_PROVIDER_MODE=sandbox is set",
        status: 500,
      }),
    })(request("POST", validRequest()), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "B2B inquiry submit failed",
        details: { reason: "upstream_unavailable" },
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "partners_b2b_inquiry_submit_failed",
      expect.stringContaining("RESEND_API_KEY is required"),
    );

    errorSpy.mockRestore();
  });
});

function createSubmitPort(result: unknown): PartnersB2BInquirySubmitPort {
  return {
    submitB2BInquiry: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function validRequest() {
  return {
    company: "Acme Pet Foods",
    country: "US",
    firstName: "Jane",
    lastName: "Smith",
    email: "jane@acmepets.com",
    phone: "+1 555 123 4567",
    notes: "Private label wet dog food for retail.",
  };
}

function request(method: string, body: unknown): VercelRequest {
  return {
    method,
    body,
    headers: {
      "user-agent": "test-agent",
      "x-forwarded-for": "127.0.0.1",
    },
  } as unknown as VercelRequest;
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
