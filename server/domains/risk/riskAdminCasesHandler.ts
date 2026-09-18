import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminRiskCaseDecisionRequestSchema,
  adminRiskCaseDecisionResponseSchema,
  adminRiskCaseDetailRequestSchema,
  adminRiskCaseDetailResponseSchema,
  adminRiskCasesListRequestSchema,
  adminRiskCasesListResponseSchema,
} from "../../../src/domains/risk/contracts.js";
import type { RiskAdminReadPort, RiskAdminWritePort } from "../../../src/domains/risk/ports.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<{ userId: string } | null> {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return null;
    }
    return { userId: authorization.userId };
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
}

export function createAdminRiskCasesListHandler({
  authorizeAdmin,
  riskPort,
}: {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  riskPort: RiskAdminReadPort;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminRiskCasesListRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid risk cases request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = adminRiskCasesListResponseSchema.parse(await riskPort.listCases(request.data));
      sendBffSuccess(res, result);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Risk cases read failed");
    }
  };
}

export function createAdminRiskCaseDetailHandler({
  authorizeAdmin,
  riskPort,
}: {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  riskPort: RiskAdminReadPort;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminRiskCaseDetailRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid risk case detail request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = await riskPort.getCaseDetail(request.data);
      if (!result) {
        sendBffError(res, "NOT_FOUND", "Risk case not found");
        return;
      }
      sendBffSuccess(res, adminRiskCaseDetailResponseSchema.parse(result));
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Risk case detail failed");
    }
  };
}

export function createAdminRiskCaseDecisionHandler({
  authorizeAdmin,
  riskPort,
  mutationsEnabled,
}: {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  riskPort: RiskAdminWritePort;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    if (!mutationsEnabled()) {
      sendBffError(res, "FORBIDDEN", "Risk review mutations are not enabled");
      return;
    }

    const request = adminRiskCaseDecisionRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid risk decision request", { details: request.error.flatten() });
      return;
    }
    try {
      const result = await riskPort.decideCase({ ...request.data, actorUserId: auth.userId });
      sendBffSuccess(res, adminRiskCaseDecisionResponseSchema.parse(result));
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Risk decision failed");
    }
  };
}
