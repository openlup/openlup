import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminNotificationRecipientsRequestSchema,
  adminNotificationRecipientsResponseSchema,
  createNotificationRecipientRequestSchema,
  createNotificationRecipientResponseSchema,
  deleteNotificationRecipientRequestSchema,
  deleteNotificationRecipientResponseSchema,
  updateNotificationRecipientRequestSchema,
  updateNotificationRecipientResponseSchema,
} from "../../../src/domains/communications/contracts.js";
import {
  CommunicationConflictError,
  type CommunicationNotificationRecipientsPort,
} from "../../../src/domains/communications/ports.js";

export interface CommunicationsNotificationRecipientsHandlerDeps {
  recipientsPort: CommunicationNotificationRecipientsPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createCommunicationsNotificationRecipientsHandler({
  recipientsPort,
  authorizeAdmin,
}: CommunicationsNotificationRecipientsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method ?? "")) {
      sendMethodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
      return;
    }

    if (!(await authorizeAdmin(req))) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    if (req.method === "GET") return list(req, res, recipientsPort);
    if (req.method === "POST") return create(req, res, recipientsPort);
    if (req.method === "PATCH") return update(req, res, recipientsPort);
    return remove(req, res, recipientsPort);
  };
}

async function list(
  req: VercelRequest,
  res: VercelResponse,
  recipientsPort: CommunicationNotificationRecipientsPort,
) {
  const request = adminNotificationRecipientsRequestSchema.safeParse(req.query);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid notification recipients list request", {
      details: request.error.flatten(),
    });
    return;
  }

  try {
    const result = await recipientsPort.listNotificationRecipients(request.data);
    const response = adminNotificationRecipientsResponseSchema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Notification recipients list returned invalid response");
      return;
    }
    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Notification recipients list failed");
  }
}

async function create(
  req: VercelRequest,
  res: VercelResponse,
  recipientsPort: CommunicationNotificationRecipientsPort,
) {
  const request = createNotificationRecipientRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid notification recipient create request", {
      details: request.error.flatten(),
    });
    return;
  }

  try {
    const result = await recipientsPort.createNotificationRecipient(request.data);
    const response = createNotificationRecipientResponseSchema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Notification recipient create returned invalid response");
      return;
    }
    sendBffSuccess(res, response.data);
  } catch (error) {
    if (error instanceof CommunicationConflictError) {
      sendBffError(res, "CONFLICT", error.message);
      return;
    }
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Notification recipient create failed");
  }
}

async function update(
  req: VercelRequest,
  res: VercelResponse,
  recipientsPort: CommunicationNotificationRecipientsPort,
) {
  const request = updateNotificationRecipientRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid notification recipient update request", {
      details: request.error.flatten(),
    });
    return;
  }

  try {
    const result = await recipientsPort.updateNotificationRecipient(request.data);
    const response = updateNotificationRecipientResponseSchema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Notification recipient update returned invalid response");
      return;
    }
    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Notification recipient update failed");
  }
}

async function remove(
  req: VercelRequest,
  res: VercelResponse,
  recipientsPort: CommunicationNotificationRecipientsPort,
) {
  const request = deleteNotificationRecipientRequestSchema.safeParse(req.body);
  if (!request.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid notification recipient delete request", {
      details: request.error.flatten(),
    });
    return;
  }

  try {
    const result = await recipientsPort.deleteNotificationRecipient(request.data);
    const response = deleteNotificationRecipientResponseSchema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Notification recipient delete returned invalid response");
      return;
    }
    sendBffSuccess(res, response.data);
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Notification recipient delete failed");
  }
}
