import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  sendEmailRequestSchema,
  sendEmailResponseSchema,
} from "../../../src/domains/communications/contracts.js";
import {
  CommunicationConflictError,
  CommunicationRecipientNotFoundError,
  CommunicationTemplateNotFoundError,
  CommunicationUnavailableError,
  CommunicationValidationError,
  type CommunicationSendPort,
} from "../../../src/domains/communications/ports.js";

export interface CommunicationsSendEmailHandlerDeps {
  sendPort: CommunicationSendPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createCommunicationsSendEmailHandler({
  sendPort,
  authorizeAdmin,
}: CommunicationsSendEmailHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    if (!(await authorizeAdmin(req))) {
      sendBffError(res, "UNAUTHORIZED", "Admin session required");
      return;
    }

    const request = sendEmailRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid communications send-email request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await sendPort.sendEmail(request.data);
      const response = sendEmailResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Communications send port returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      if (
        error instanceof CommunicationRecipientNotFoundError ||
        error instanceof CommunicationTemplateNotFoundError
      ) {
        sendBffError(res, "NOT_FOUND", error.message);
        return;
      }
      if (error instanceof CommunicationConflictError) {
        sendBffError(res, "CONFLICT", error.message);
        return;
      }
      if (error instanceof CommunicationValidationError) {
        sendBffError(res, "BAD_REQUEST", error.message);
        return;
      }
      if (error instanceof CommunicationUnavailableError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", error.message);
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Communications send-email request failed");
    }
  };
}
