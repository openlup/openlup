import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import { adminUserRoleUpdateRequestSchema, adminUserRoleUpdateResponseSchema, adminUserInviteRequestSchema, adminUserInviteResponseSchema, adminUserRemoveRequestSchema, adminUserRemoveResponseSchema } from "./adminContracts.js";
import type { PlatformAdminAuthorizationResult } from "./platformAdminAuth.js";
export interface IdentityAdminActionsPort {
  inviteAdminUser(request: { email: string; role: "admin" | "distributor" }): Promise<{ message?: string }>;
  removeAdminUser(request: { userId: string }): Promise<{ revoked: true }>;
  updateAdminUserRole(request: { userId: string; role: "admin" | "distributor" }): Promise<{ userId: string; role: "admin" | "distributor"; saved: true }>;
}
export interface AdminUserRoleUpdateDeps extends IdentityResponseOptions { settingsPort: Pick<IdentityAdminActionsPort, "updateAdminUserRole">; authorizeAdmin: (req: HttpRequest) => Promise<PlatformAdminAuthorizationResult> }
export interface AdminUserInviteDeps extends IdentityResponseOptions { settingsPort: Pick<IdentityAdminActionsPort, "inviteAdminUser">; authorizeAdmin: (req: HttpRequest) => Promise<PlatformAdminAuthorizationResult> }
export interface AdminUserRemoveDeps extends IdentityResponseOptions { settingsPort: Pick<IdentityAdminActionsPort, "removeAdminUser">; authorizeAdmin: (req: HttpRequest) => Promise<PlatformAdminAuthorizationResult> }
export function createAdminUserRoleUpdateHandler({
  settingsPort,
  authorizeAdmin, responseRequestId,
}: AdminUserRoleUpdateDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
  authorizeAdmin, responseRequestId,
}: AdminUserInviteDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
  authorizeAdmin, responseRequestId,
}: AdminUserRemoveDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
      sendMutationError(res, error, "Admin user revoke failed", responseRequestId);
    }
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sendMutationError(res: HttpResponse, error: unknown, fallback: string, responseRequestId: IdentityResponseOptions["responseRequestId"]): void {
  const { sendBffError } = createIdentityResponder({ responseRequestId });
  const bffCode = (error as { bffCode?: string })?.bffCode;
  if (bffCode) {
    sendBffError(res, bffCode as Parameters<typeof sendBffError>[1], errorMessage(error, fallback));
    return;
  }
  sendBffError(res, "UPSTREAM_UNAVAILABLE", errorMessage(error, fallback));
}
