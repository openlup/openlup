import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  cleanupDhlShipmentResponseSchema,
  type CleanupDhlShipmentRequest,
  type CleanupDhlShipmentResponse,
} from "./contracts";

const PATH = "/api/bff/admin/fulfillment/dhl-cleanup";

export function cleanupAdminDhlShipment(
  accessToken: string,
  request: CleanupDhlShipmentRequest,
  options: BffRequestOptions = {},
): Promise<CleanupDhlShipmentResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, cleanupDhlShipmentResponseSchema, {
    ...options,
    method: "POST",
    headers,
    body: request,
  });
}
