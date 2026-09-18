import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminMagicLinkResponseSchema,
  type AdminMagicLinkResponse,
} from "./contracts";

const PATH = "/api/bff/admin/platform/magic-link";

export function requestAdminMagicLink(
  email: string,
  options: BffRequestOptions = {},
): Promise<AdminMagicLinkResponse> {
  return requestBff(PATH, adminMagicLinkResponseSchema, {
    ...options,
    method: "POST",
    body: { email },
  });
}
