import type { HttpRequest, HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import {
  adminRiskCaseDecisionRequestSchema,
  adminRiskCaseDecisionResponseSchema,
  adminRiskCaseDetailRequestSchema,
  adminRiskCaseDetailResponseSchema,
  adminRiskCasesListRequestSchema,
  adminRiskCasesListResponseSchema,
} from "../../risk/index.js";
import type { RiskAdminReadPort, RiskAdminWritePort } from "../../risk/contracts/index.js";

export type RiskAdminAuthorization =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

async function authorize(
  req: HttpRequest,
  res: HttpResponse,
  authorizeAdmin: (req: HttpRequest) => Promise<RiskAdminAuthorization>,
  respond: BffResponder,
): Promise<{ userId: string } | null> {
  const { sendBffError } = respond;
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
  respond,
}: {
  respond: BffResponder;
  authorizeAdmin: (req: HttpRequest) => Promise<RiskAdminAuthorization>;
  riskPort: RiskAdminReadPort;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, respond))) return;

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
  respond,
}: {
  respond: BffResponder;
  authorizeAdmin: (req: HttpRequest) => Promise<RiskAdminAuthorization>;
  riskPort: RiskAdminReadPort;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, respond))) return;

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
  respond,
  mutationsEnabled,
}: {
  respond: BffResponder;
  authorizeAdmin: (req: HttpRequest) => Promise<RiskAdminAuthorization>;
  riskPort: RiskAdminWritePort;
  mutationsEnabled: () => boolean;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = respond;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, respond);
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
