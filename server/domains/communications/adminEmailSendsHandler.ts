import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminEmailSendEventsRequestSchema,
  adminEmailSendEventsResponseSchema,
  adminEmailSendsRequestSchema,
  adminEmailSendsResponseSchema,
} from "../../../src/domains/communications/contracts.js";
import type { CommunicationAdminEmailSendsReadPort } from "../../../src/domains/communications/ports.js";

export interface CommunicationsAdminEmailSendsHandlerDeps {
  readPort: CommunicationAdminEmailSendsReadPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createCommunicationsAdminEmailSendsHandler({
  readPort,
  authorizeAdmin,
}: CommunicationsAdminEmailSendsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    if (!(await authorizeAdmin(req))) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    const request = adminEmailSendsRequestSchema.safeParse({
      status: scalarQuery(req.query.status),
      template: scalarQuery(req.query.template),
      search: scalarQuery(req.query.search),
      page: scalarQuery(req.query.page),
      pageSize: scalarQuery(req.query.pageSize),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin email sends request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await readPort.getAdminEmailSends(request.data);
      const response = adminEmailSendsResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin email sends returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin email sends read failed", {
        details: { reason: "admin_email_sends_read_failed" },
      });
    }
  };
}

export function createCommunicationsAdminEmailSendEventsHandler({
  readPort,
  authorizeAdmin,
}: CommunicationsAdminEmailSendsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    if (!(await authorizeAdmin(req))) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    const request = adminEmailSendEventsRequestSchema.safeParse({
      sendId: scalarQuery(req.query.sendId),
    });
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin email send events request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await readPort.getAdminEmailSendEvents(request.data);
      const response = adminEmailSendEventsResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin email send events returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin email send events read failed", {
        details: { reason: "admin_email_send_events_read_failed" },
      });
    }
  };
}

function scalarQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
