import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerMeResponseSchema,
  type CustomerMeResponse,
} from "./contracts";

const PATH = "/api/bff/customers/me";

export function getCustomerMe(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerMeResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, customerMeResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}
