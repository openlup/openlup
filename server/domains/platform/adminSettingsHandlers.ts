import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
export type { AdminUserRoleUpdateDeps, AdminUserInviteDeps, AdminUserRemoveDeps } from "@openlup/platform/identity";
import { createAdminUserRemoveHandler as createAdminUserRemoveHandlerFromIdentity, type AdminUserRemoveDeps } from "@openlup/platform/identity";
import { createAdminUserInviteHandler as createAdminUserInviteHandlerFromIdentity, type AdminUserInviteDeps } from "@openlup/platform/identity";
import { createAdminUserRoleUpdateHandler as createAdminUserRoleUpdateHandlerFromIdentity, type AdminUserRoleUpdateDeps } from "@openlup/platform/identity";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminSettingsReadRequestSchema,
  adminSettingsReadResponseSchema,
  adminSettingsUpdateRequestSchema,
  adminSettingsUpdateResponseSchema,
} from "../../../src/domains/platform/contracts.js";
import type { AdminSettingsPort } from "../../../src/domains/platform/ports.js";
import type { PlatformAdminAuthorizationResult } from "./adminAuth.js";

export interface AdminSettingsReadDeps {
  settingsPort: Pick<AdminSettingsPort, "readSettings">;
  authorizeAdmin: (req: VercelRequest) => Promise<PlatformAdminAuthorizationResult>;
}

export interface AdminSettingsUpdateDeps {
  settingsPort: Pick<AdminSettingsPort, "updateSetting">;
  authorizeAdmin: (req: VercelRequest) => Promise<PlatformAdminAuthorizationResult>;
}

export function createAdminSettingsReadHandler({
  settingsPort,
  authorizeAdmin,
}: AdminSettingsReadDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    let authorization: PlatformAdminAuthorizationResult;
    try {
      authorization = await authorizeAdmin(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return;
    }

    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return;
    }

    const request = adminSettingsReadRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin settings read request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await settingsPort.readSettings(request.data);
      const response = adminSettingsReadResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin settings read returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin settings read failed");
    }
  };
}

export function createAdminSettingsUpdateHandler({
  settingsPort,
  authorizeAdmin,
}: AdminSettingsUpdateDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    let authorization: PlatformAdminAuthorizationResult;
    try {
      authorization = await authorizeAdmin(req);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return;
    }

    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return;
    }

    const request = adminSettingsUpdateRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin settings update request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await settingsPort.updateSetting(request.data);
      const response = adminSettingsUpdateResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin settings update returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin settings update failed");
    }
  };
}


export function createAdminUserRoleUpdateHandler(deps: AdminUserRoleUpdateDeps) {
  return createAdminUserRoleUpdateHandlerFromIdentity({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}

export function createAdminUserInviteHandler(deps: AdminUserInviteDeps) {
  return createAdminUserInviteHandlerFromIdentity({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}

export function createAdminUserRemoveHandler(deps: AdminUserRemoveDeps) {
  return createAdminUserRemoveHandlerFromIdentity({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}
