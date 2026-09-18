import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customerMagicLinkResponseSchema,
  type CustomerMagicLinkResponse,
} from "./contracts";

const PATH = "/api/bff/customers/magic-link";

export type CustomerMagicLinkRequestOptions = BffRequestOptions & {
  returnTo?: string | null;
};

export function requestCustomerMagicLink(
  email: string,
  locale: "pl" | "en" = "pl",
  options: CustomerMagicLinkRequestOptions = {},
): Promise<CustomerMagicLinkResponse> {
  const { returnTo, ...requestOptions } = options;
  return requestBff(PATH, customerMagicLinkResponseSchema, {
    ...requestOptions,
    method: "POST",
    body: { email, locale, ...(returnTo ? { returnTo } : {}) },
  });
}
