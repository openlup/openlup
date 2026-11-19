import { requestBff } from "@/lib/bff/client";
import { sellableCatalogListResponseSchema } from "@/domains/catalog/contracts";
import {
  referenceCheckoutRequestSchema,
  referenceCheckoutResponseSchema,
  type ReferenceCheckoutRequest,
} from "@/domains/commerce/checkoutCommandContracts";

export function loadReferenceItems() {
  return requestBff("/api/bff/catalog/items", sellableCatalogListResponseSchema, { method: "GET" });
}

export function createReferenceSubscription(request: ReferenceCheckoutRequest, accessToken: string | null = null) {
  return requestBff("/api/bff/commerce/checkouts", referenceCheckoutResponseSchema, {
    method: "POST",
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
    body: referenceCheckoutRequestSchema.parse(request),
    timeoutMs: 30_000,
  });
}
