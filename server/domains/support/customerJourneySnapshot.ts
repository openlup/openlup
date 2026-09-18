import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  customerJourneyLookupRequestSchema,
  customerJourneySearchResultSchema,
  customerJourneySnapshotResponseSchema,
  type CustomerJourneyLookupRequest,
  type CustomerJourneySearchResult,
  type CustomerJourneySnapshotResponse,
} from "../../../src/domains/support/customerJourneyContracts.js";
import {
  applyOmsAgentCustomerReadGate,
  type OmsAgentReadGovernance,
} from "../../_lib/admin-domain/customerReadGovernance.js";
import { compact } from "./customerJourneyCommon.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string; isMachineActor?: boolean };

export interface CustomerJourneySnapshotPort {
  search(request: CustomerJourneyLookupRequest): Promise<CustomerJourneySearchResult>;
  snapshot(request: CustomerJourneyLookupRequest): Promise<CustomerJourneySnapshotResponse | null>;
}

export function createCustomerJourneySnapshotHandler({
  authorizeAdmin,
  snapshotPort,
  governance,
}: {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
  snapshotPort: CustomerJourneySnapshotPort;
  governance?: OmsAgentReadGovernance;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;

    const parsed = customerJourneyLookupRequestSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid customer journey lookup request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const request = parsed.data;
    const gate = applyOmsAgentCustomerReadGate({
      authorization: auth,
      governance,
      res,
      route: "/api/bff/admin/support/customer-journey",
      query: auditSafeLookup(request),
    });
    if (gate.blocked) return;

    try {
      const mode = typeof req.query?.mode === "string" ? req.query.mode : null;
      if (mode === "search") {
        const result = await snapshotPort.search(request);
        const response = customerJourneySearchResultSchema.safeParse(result);
        if (!response.success) {
          sendBffError(res, "INVALID_RESPONSE", "Customer journey search returned invalid response");
          return;
        }
        await gate.audit(compact(response.data.candidates.map((candidate) => candidate.clientId)));
        sendBffSuccess(res, response.data);
        return;
      }

      const snapshot = await snapshotPort.snapshot(request);
      if (!snapshot) {
        sendBffError(res, "NOT_FOUND", "Customer journey evidence not found");
        return;
      }
      const response = customerJourneySnapshotResponseSchema.safeParse(snapshot);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Customer journey snapshot returned invalid response");
        return;
      }
      await gate.audit(response.data.customer.clientId ? [response.data.customer.clientId] : []);
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Customer journey snapshot read failed");
    }
  };
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<Extract<AdminAuthResult, { ok: true }> | null> {
  const auth = await authorizeAdmin(req);
  if (auth.ok === false) {
    sendBffError(res, auth.code, auth.message);
    return null;
  }
  return auth;
}

function auditSafeLookup(request: CustomerJourneyLookupRequest): Record<string, unknown> {
  return {
    ...request,
    email: request.email ? "[redacted]" : undefined,
    query: request.query ? "[redacted]" : undefined,
  };
}

export { buildCustomerJourneySnapshotFromRows } from "./customerJourneyRowsSnapshot.js";
