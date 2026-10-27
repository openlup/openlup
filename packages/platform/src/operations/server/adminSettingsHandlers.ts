import { createBffResponder, type BffResponderOptions } from "../../bff/index.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import {
  adminSettingsReadRequestSchema,
  adminSettingsReadResponseSchema,
  adminSettingsUpdateRequestSchema,
  adminSettingsUpdateResponseSchema,
} from "../index.js";
import type { AdminSettingsOperationsPort } from "../contracts/index.js";
import type { OperationsAuthorizationResult } from "../contracts/index.js";

export interface AdminSettingsReadDeps extends BffResponderOptions {
  settingsPort: Pick<AdminSettingsOperationsPort, "readSettings">;
  authorizeAdmin: (req: HttpRequest) => Promise<OperationsAuthorizationResult>;
}

export interface AdminSettingsUpdateDeps extends BffResponderOptions {
  settingsPort: Pick<AdminSettingsOperationsPort, "updateSetting">;
  authorizeAdmin: (req: HttpRequest) => Promise<OperationsAuthorizationResult>;
}

export function createAdminSettingsReadHandler({
  settingsPort,
  authorizeAdmin, responseRequestId,
}: AdminSettingsReadDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createBffResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    let authorization: OperationsAuthorizationResult;
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
  authorizeAdmin, responseRequestId,
}: AdminSettingsUpdateDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createBffResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    let authorization: OperationsAuthorizationResult;
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
