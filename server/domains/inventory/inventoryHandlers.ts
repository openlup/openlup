import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminInventoryReservationsRequestSchema,
  adminInventoryStockAdjustmentRequestSchema,
  adminInventoryStockRequestSchema,
  adminInventorySubscriptionForecastRequestSchema,
  inventoryAtpRequestSchema,
  inventoryAtpResultSchema,
  inventoryReservationsListResponseSchema,
  inventoryStockListResponseSchema,
  inventorySubscriptionForecastResponseSchema,
} from "../../../src/domains/inventory/contracts.js";
import {
  InventoryConflictError,
  type InventoryMutationPort,
  type InventoryReadPort,
} from "../../../src/domains/inventory/ports.js";

type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

interface BaseDeps {
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>;
}

export function createAdminInventoryStockHandler({
  authorizeAdmin,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "listStock"> }) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminInventoryStockRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin inventory stock request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inventoryPort.listStock(request.data);
      const response = inventoryStockListResponseSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Inventory stock response invalid");
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inventory stock read failed");
    }
  };
}

export function createAdminInventoryReservationsHandler({
  authorizeAdmin,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "listReservations"> }) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminInventoryReservationsRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin inventory reservations request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inventoryPort.listReservations(request.data);
      const response = inventoryReservationsListResponseSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Inventory reservations response invalid");
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inventory reservations read failed");
    }
  };
}

export function createAdminInventoryAtpCheckHandler({
  authorizeAdmin,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "checkAtp"> }) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = inventoryAtpRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin inventory ATP request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inventoryPort.checkAtp(request.data);
      const response = inventoryAtpResultSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Inventory ATP response invalid");
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inventory ATP check failed");
    }
  };
}

export function createAdminInventorySubscriptionForecastHandler({
  authorizeAdmin,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "forecastSubscriptions"> }) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin))) return;

    const request = adminInventorySubscriptionForecastRequestSchema.safeParse(req.query);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin inventory subscription forecast request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inventoryPort.forecastSubscriptions(request.data);
      const response = inventorySubscriptionForecastResponseSchema.safeParse(result);
      if (!response.success) {
        return sendBffError(res, "INVALID_RESPONSE", "Inventory subscription forecast response invalid");
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inventory subscription forecast read failed");
    }
  };
}

export function createAdminInventoryStockAdjustmentHandler({
  authorizeAdmin,
  inventoryPort,
  mutationsEnabled,
}: BaseDeps & {
  inventoryPort: Pick<InventoryMutationPort, "adjustStock">;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;
    if (!mutationsEnabled()) {
      sendBffError(res, "FORBIDDEN", "Inventory mutations are not enabled");
      return;
    }

    const request = adminInventoryStockAdjustmentRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin inventory stock adjustment request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      sendBffSuccess(res, await inventoryPort.adjustStock({ ...request.data, actorUserId: auth.userId }));
    } catch (error) {
      if (error instanceof InventoryConflictError) {
        sendBffError(res, "CONFLICT", error.message, { details: error.details });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inventory stock adjustment failed");
    }
  };
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<AdminAuthResult>,
): Promise<{ userId: string } | null> {
  try {
    const authorization = await authorizeAdmin(req);
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return null;
    }
    return { userId: authorization.userId };
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return null;
  }
}
