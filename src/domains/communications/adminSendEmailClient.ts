import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  sendEmailResponseSchema,
  type SendEmailRequest,
  type SendEmailResponse,
} from "./contracts";

const PATH = "/api/bff/admin/communications/send-email";

export function sendAdminEmail(
  accessToken: string,
  request: SendEmailRequest,
  options: BffRequestOptions = {},
): Promise<SendEmailResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, sendEmailResponseSchema, {
    ...options,
    method: "POST",
    headers,
    body: request,
  });
}
