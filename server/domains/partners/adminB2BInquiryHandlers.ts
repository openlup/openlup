import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  partnersB2BInquiryListRequestSchema,
  partnersB2BInquiryListResponseSchema,
  partnersB2BInquiryStatusUpdateRequestSchema,
  partnersB2BInquiryStatusUpdateResponseSchema,
} from "../../../src/domains/partners/contracts.js";
import type { PartnersB2BInquiryAdminPort } from "../../../src/domains/partners/ports.js";
import type { PartnersAdminAuthorizationResult } from "./adminAuth.js";

interface PartnersAdminB2BInquiryBaseDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<PartnersAdminAuthorizationResult>;
}

interface PartnersAdminB2BInquiryListDeps extends PartnersAdminB2BInquiryBaseDeps {
  inquiryPort: Pick<PartnersB2BInquiryAdminPort, "listB2BInquiries">;
}

interface PartnersAdminB2BInquiryStatusDeps extends PartnersAdminB2BInquiryBaseDeps {
  inquiryPort: Pick<PartnersB2BInquiryAdminPort, "updateB2BInquiryStatus">;
}

export function createPartnersAdminB2BInquiryListHandler({
  inquiryPort,
  authorizeAdmin,
}: PartnersAdminB2BInquiryListDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorization = await readAuthorization(req, res, authorizeAdmin);
    if (!authorization) return;

    const request = partnersB2BInquiryListRequestSchema.safeParse({
      status: readQueryValue(req.query.status, "all"),
      search: readQueryValue(req.query.search, ""),
      page: readQueryValue(req.query.page, "0"),
      pageSize: readQueryValue(req.query.pageSize, "50"),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid B2B inquiry list request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inquiryPort.listB2BInquiries(request.data);
      const response = partnersB2BInquiryListResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "B2B inquiry list returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "B2B inquiry list read failed");
    }
  };
}

export function createPartnersAdminB2BInquiryStatusHandler({
  inquiryPort,
  authorizeAdmin,
}: PartnersAdminB2BInquiryStatusDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const authorization = await readAuthorization(req, res, authorizeAdmin);
    if (!authorization) return;

    const request = partnersB2BInquiryStatusUpdateRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid B2B inquiry status update request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inquiryPort.updateB2BInquiryStatus(request.data);
      const response = partnersB2BInquiryStatusUpdateResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "B2B inquiry status update returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "B2B inquiry status update failed");
    }
  };
}

async function readAuthorization(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<PartnersAdminAuthorizationResult>,
): Promise<true | null> {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return null;
    }
    return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
}

function readQueryValue(value: string | string[] | undefined, fallback: string): string {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}
