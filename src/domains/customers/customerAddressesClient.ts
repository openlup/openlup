import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerAddressesResponseSchema,
  type CustomerAddressesResponse,
} from "./contracts";

const PATH = "/api/bff/customers/addresses";

export function getCustomerAddresses(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<CustomerAddressesResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, customerAddressesResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}
