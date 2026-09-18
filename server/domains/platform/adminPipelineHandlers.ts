import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminPipelineDhlTrackingRefreshRequestSchema,
  adminPipelineDhlTrackingRefreshResponseSchema,
  adminPipelineReadRequestSchema,
  adminPipelineReadResponseSchema,
} from "../../../src/domains/platform/contracts.js";
import type { AdminPipelinePort } from "../../../src/domains/platform/ports.js";
import type { PlatformAdminAuthorizationResult } from "./adminAuth.js";

interface AdminPipelineBaseDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<PlatformAdminAuthorizationResult>;
}

interface AdminPipelineReadDeps extends AdminPipelineBaseDeps {
  pipelinePort: Pick<AdminPipelinePort, "readPipeline">;
}

interface AdminPipelineDhlTrackingDeps extends AdminPipelineBaseDeps {
  pipelinePort: Pick<AdminPipelinePort, "refreshDhlTracking">;
}

export function createAdminPipelineReadHandler({
  pipelinePort,
  authorizeAdmin,
}: AdminPipelineReadDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorization = await readAuthorization(req, res, authorizeAdmin);
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

export function createAdminPipelineDhlTrackingRefreshHandler({
  pipelinePort,
  authorizeAdmin,
}: AdminPipelineDhlTrackingDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const authorization = await readAuthorization(req, res, authorizeAdmin);
    if (!authorization) return;

    const request = adminPipelineDhlTrackingRefreshRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid DHL tracking refresh request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await pipelinePort.refreshDhlTracking(request.data);
      const response = adminPipelineDhlTrackingRefreshResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "DHL tracking refresh returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "DHL tracking refresh failed");
    }
  };
}

async function readAuthorization(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<PlatformAdminAuthorizationResult>,
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
