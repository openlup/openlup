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
  adminUserInviteRequestSchema,
  adminUserInviteResponseSchema,
  adminUserRemoveRequestSchema,
  adminUserRemoveResponseSchema,
  adminUserRoleUpdateRequestSchema,
  adminUserRoleUpdateResponseSchema,
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

export interface AdminUserRoleUpdateDeps {
  settingsPort: Pick<AdminSettingsPort, "updateAdminUserRole">;
  authorizeAdmin: (req: VercelRequest) => Promise<PlatformAdminAuthorizationResult>;
}

export interface AdminUserInviteDeps {
  settingsPort: Pick<AdminSettingsPort, "inviteAdminUser">;
  authorizeAdmin: (req: VercelRequest) => Promise<PlatformAdminAuthorizationResult>;
}

export interface AdminUserRemoveDeps {
  settingsPort: Pick<AdminSettingsPort, "removeAdminUser">;
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

export function createAdminUserRoleUpdateHandler({
  settingsPort,
  authorizeAdmin,
}: AdminUserRoleUpdateDeps) {
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

    const request = adminUserRoleUpdateRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin user role update request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await settingsPort.updateAdminUserRole(request.data);
      const response = adminUserRoleUpdateResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin user role update returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      const bffCode = (error as { bffCode?: string })?.bffCode;
      if (bffCode) {
        sendBffError(res, bffCode as Parameters<typeof sendBffError>[1], (error as Error).message);
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin user role update failed");
    }
  };
}

export function createAdminUserInviteHandler({
  settingsPort,
  authorizeAdmin,
}: AdminUserInviteDeps) {
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

    const request = adminUserInviteRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin user invite request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await settingsPort.inviteAdminUser(request.data);
      const response = adminUserInviteResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin user invite returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", errorMessage(error, "Admin user invite failed"));
    }
  };
}

export function createAdminUserRemoveHandler({
  settingsPort,
  authorizeAdmin,
}: AdminUserRemoveDeps) {
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

    const request = adminUserRemoveRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin user remove request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await settingsPort.removeAdminUser(request.data);
      const response = adminUserRemoveResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin user remove returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch (error) {
      sendMutationError(res, error, "Admin user revoke failed");
    }
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sendMutationError(res: VercelResponse, error: unknown, fallback: string): void {
  const bffCode = (error as { bffCode?: string })?.bffCode;
  if (bffCode) {
    sendBffError(res, bffCode as Parameters<typeof sendBffError>[1], errorMessage(error, fallback));
    return;
  }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", errorMessage(error, fallback));
}
