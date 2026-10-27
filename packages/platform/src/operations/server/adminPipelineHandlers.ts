import { createBffResponder, type BffResponderOptions, type BffResponder } from "../../bff/index.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import {
  adminPipelineReadRequestSchema,
  adminPipelineReadResponseSchema,
} from "../index.js";
import type { AdminPipelineReadPort } from "../contracts/index.js";
import type { OperationsAuthorizationResult } from "../contracts/index.js";

interface AdminPipelineBaseDeps extends BffResponderOptions {
  authorizeAdmin: (req: HttpRequest) => Promise<OperationsAuthorizationResult>;
}

export interface AdminPipelineReadDeps extends AdminPipelineBaseDeps {
  pipelinePort: Pick<AdminPipelineReadPort, "readPipeline">;
}

export function createAdminPipelineReadHandler({
  pipelinePort,
  authorizeAdmin, responseRequestId,
}: AdminPipelineReadDeps) {
  const responder = createBffResponder({ responseRequestId });
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorization = await readAuthorization(req, res, authorizeAdmin, responder);
    if (!authorization) return;

    const request = adminPipelineReadRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin pipeline read request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await pipelinePort.readPipeline(request.data);
      const response = adminPipelineReadResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin pipeline read returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin pipeline read failed");
    }
  };
}

async function readAuthorization(
  req: HttpRequest,
  res: HttpResponse,
  authorizeAdmin: (req: HttpRequest) => Promise<OperationsAuthorizationResult>,
  { sendBffError }: BffResponder,
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
