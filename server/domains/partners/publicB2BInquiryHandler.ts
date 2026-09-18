import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import type { BffErrorCode } from "../../../src/lib/bff/contracts.js";
import {
  partnersB2BInquirySubmitRequestSchema,
  partnersB2BInquirySubmitResponseSchema,
} from "../../../src/domains/partners/contracts.js";
import type { PartnersB2BInquirySubmitPort } from "../../../src/domains/partners/ports.js";

export interface PartnersPublicB2BInquiryHandlerDeps {
  submitPort: PartnersB2BInquirySubmitPort;
}

export function createPartnersPublicB2BInquirySubmitHandler({
  submitPort,
}: PartnersPublicB2BInquiryHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = partnersB2BInquirySubmitRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid B2B inquiry request", {
        details: { reason: "validation_error", errors: request.error.flatten() },
      });
      return;
    }

    try {
      const result = await submitPort.submitB2BInquiry(request.data, {
        headers: headersFromRequest(req),
      });
      if (!result.success) {
        sendSubmitError(res, result);
        return;
      }

      const response = partnersB2BInquirySubmitResponseSchema.safeParse({
        success: true,
        id: result.id,
        skipped: typeof result.skipped === "string" ? result.skipped : undefined,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "B2B inquiry submit returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "B2B inquiry submit failed");
    }
  };
}

function sendSubmitError(
  res: VercelResponse,
  result: { status?: number; error?: string; code?: string },
): void {
  const mapped = mapSubmitError(result);
  if (mapped.privateReason) {
    console.error("partners_b2b_inquiry_submit_failed", JSON.stringify({
      status: result.status,
      code: result.code,
      reason: mapped.privateReason,
    }));
  }
  sendBffError(res, mapped.code, mapped.message, {
    details: { reason: mapped.reason },
    status: mapped.status,
  });
}

function mapSubmitError(result: { status?: number; error?: string; code?: string }): {
  code: BffErrorCode;
  message: string;
  reason: string;
  privateReason?: string;
  status?: number;
} {
  const reason = result.error || result.code || "b2b_inquiry_submit_failed";
  if (result.status === 429 || result.code === "rate_limit" || result.error === "rate_limit") {
    return {
      code: "RATE_LIMITED",
      message: "Too many B2B inquiries",
      reason: "rate_limit",
      status: 429,
    };
  }
  if (result.code === "validation_error" || result.status === 400) {
    return {
      code: "BAD_REQUEST",
      message: "Invalid B2B inquiry request",
      reason,
      status: 400,
    };
  }
  if (result.code === "email_origin_error" || result.error === "email_origin_error") {
    return {
      code: "UPSTREAM_UNAVAILABLE",
      message: "B2B inquiry email origin is unavailable",
      reason: "email_origin_unavailable",
      privateReason: reason,
    };
  }

  return {
    code: "UPSTREAM_UNAVAILABLE",
    message: "B2B inquiry submit failed",
    reason: "upstream_unavailable",
    privateReason: reason,
  };
}

function headersFromRequest(req: VercelRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}
