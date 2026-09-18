import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import {
  adminPrelaunchLeadDetailRequestSchema,
  adminPrelaunchLeadDetailResponseSchema,
  adminPrelaunchLeadsRequestSchema,
  adminPrelaunchLeadsResponseSchema,
} from "../../../../src/domains/marketing/prelaunch/contracts.js";
import type { MarketingPrelaunchReadPort } from "../../../../src/domains/marketing/prelaunch/ports.js";

export interface AdminPrelaunchLeadsHandlerDeps {
  readPort: MarketingPrelaunchReadPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createAdminPrelaunchLeadsHandler({ readPort, authorizeAdmin }: AdminPrelaunchLeadsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    if (!await authorize(req, res, authorizeAdmin)) return;

    const request = adminPrelaunchLeadsRequestSchema.safeParse({
      query: firstQueryValue(req.query.query),
      source: firstQueryValue(req.query.source),
      stage: firstQueryValue(req.query.stage),
      page: firstQueryValue(req.query.page),
      pageSize: firstQueryValue(req.query.pageSize),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid prelaunch leads request", { details: request.error.flatten() });
      return;
    }

    try {
      const result = await readPort.listPrelaunchLeads(request.data);
      const response = adminPrelaunchLeadsResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Prelaunch leads returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch leads read failed");
    }
  };
}

export function createAdminPrelaunchLeadDetailHandler({ readPort, authorizeAdmin }: AdminPrelaunchLeadsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    if (!await authorize(req, res, authorizeAdmin)) return;

    const request = adminPrelaunchLeadDetailRequestSchema.safeParse({
      sourceRef: firstQueryValue(req.query.sourceRef),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid prelaunch lead detail request", { details: request.error.flatten() });
      return;
    }

    try {
      const result = await readPort.getPrelaunchLead(request.data);
      const response = adminPrelaunchLeadDetailResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Prelaunch lead detail returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Prelaunch lead detail read failed");
    }
  };
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>,
): Promise<boolean> {
  try {
    if (await authorizeAdmin(req)) return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }
  sendBffError(res, "UNAUTHORIZED", "Admin session required");
  return false;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
