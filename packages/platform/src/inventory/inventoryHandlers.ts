import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { inventoryAtpRequestSchema, inventoryAtpResultSchema } from "@openlup/core/inventory";
import {
  adminInventoryReservationsRequestSchema,
  adminInventoryStockAdjustmentRequestSchema,
  adminInventoryStockRequestSchema,
  adminInventorySubscriptionForecastRequestSchema,
  inventoryReservationsListResponseSchema,
  inventoryStockListResponseSchema,
} from "./schemas.js";
import { InventoryConflictError, type InventoryMutationPort, type InventoryReadPort } from "./ports.js";
import type { InventorySubscriptionForecastResponse } from "./contracts/index.js";

// Structural host bindings keep response context and HTTP composition with the host.
interface HttpRequest extends IncomingMessage {
  query: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  body?: unknown;
}
interface HttpResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
  send(body: string | Buffer | object): this;
  redirect(url: string): this;
  redirect(status: number, url: string): this;
}
interface ResponseBindings {
  sendBffSuccess(res: HttpResponse, data: unknown): void;
  sendBffError(res: HttpResponse, code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "INVALID_RESPONSE" | "UPSTREAM_UNAVAILABLE" | "CONFLICT", message: string, options?: { details?: unknown }): void;
  sendMethodNotAllowed(res: HttpResponse, methods: readonly string[]): void;
}
type AdminAuthResult =
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string }
  | { ok: true; userId: string };

interface BaseDeps extends ResponseBindings {
  authorizeAdmin: (req: HttpRequest) => Promise<AdminAuthResult>;
}

export function createAdminInventoryStockHandler({
  authorizeAdmin,
  sendBffError, sendBffSuccess, sendMethodNotAllowed,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "listStock"> }) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, sendBffError))) return;

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
  sendBffError, sendBffSuccess, sendMethodNotAllowed,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "listReservations"> }) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, sendBffError))) return;

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
  sendBffError, sendBffSuccess, sendMethodNotAllowed,
  inventoryPort,
  configuredRegion,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "checkAtp">; configuredRegion?: string }) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!(await authorize(req, res, authorizeAdmin, sendBffError))) return;

    const request = inventoryAtpRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin inventory ATP request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await inventoryPort.checkAtp({
        ...request.data,
        region: request.data.region ?? configuredRegion,
      });
      const response = inventoryAtpResultSchema.safeParse(result);
      if (!response.success) return sendBffError(res, "INVALID_RESPONSE", "Inventory ATP response invalid");
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Inventory ATP check failed");
    }
  };
}

export function createAdminInventorySubscriptionForecastHandler({
  inventorySubscriptionForecastResponseSchema,
  authorizeAdmin,
  sendBffError, sendBffSuccess, sendMethodNotAllowed,
  inventoryPort,
}: BaseDeps & { inventoryPort: Pick<InventoryReadPort, "forecastSubscriptions">; inventorySubscriptionForecastResponseSchema: z.ZodType<InventorySubscriptionForecastResponse> }) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res, authorizeAdmin, sendBffError))) return;

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
  sendBffError, sendBffSuccess, sendMethodNotAllowed,
  inventoryPort,
  mutationsEnabled,
}: BaseDeps & {
  inventoryPort: Pick<InventoryMutationPort, "adjustStock">;
  mutationsEnabled: () => boolean;
}) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin, sendBffError);
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
  req: HttpRequest,
  res: HttpResponse,
  authorizeAdmin: (req: HttpRequest) => Promise<AdminAuthResult>,
  sendBffError: ResponseBindings["sendBffError"],
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
