import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminPlatformMeResponseSchema,
  type AdminPlatformMeResponse,
} from "./contracts";

const PATH = "/api/bff/admin/platform/me";

export function getAdminPlatformMe(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminPlatformMeResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, adminPlatformMeResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}
