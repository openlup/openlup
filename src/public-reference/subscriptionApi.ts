import { z } from "@/lib/validation/zod";
import { requestBff } from "@/lib/bff/client";
import { sellableCatalogListResponseSchema } from "@/domains/catalog/contracts";
import {
  referenceCheckoutRequestSchema,
  referenceCheckoutResponseSchema,
  type ReferenceCheckoutRequest,
} from "@/domains/commerce/checkoutCommandContracts";

const referenceAccessTokenStorageKey = "openlup.reference.customerToken";
const referenceAccountIdStorageKey = "openlup.reference.accountId";
const magicLinkResponseSchema = z.object({ accepted: z.literal(true) }).strict();

export function loadReferenceItems() {
  return requestBff("/api/bff/catalog/items", sellableCatalogListResponseSchema, { method: "GET" });
}

export function createReferenceSubscription(request: ReferenceCheckoutRequest) {
  return requestBff("/api/bff/commerce/checkouts", referenceCheckoutResponseSchema, {
    method: "POST",
    body: referenceCheckoutRequestSchema.parse(request),
    timeoutMs: 30_000,
  });
}

/** The selected profile accepts only email; the broader customer client sends locale. */
export function requestReferenceSignIn(email: string) {
  return requestBff("/api/bff/customers/magic-link", magicLinkResponseSchema, {
    method: "POST",
    body: { email: email.trim().toLowerCase() },
  });
}

export type ReferenceSession = { accessToken: string; accountId: string };

export function saveReferenceSession(session: ReferenceSession): void {
  sessionStorage.setItem(referenceAccessTokenStorageKey, session.accessToken);
  sessionStorage.setItem(referenceAccountIdStorageKey, session.accountId);
}

export function readReferenceSession(): ReferenceSession | null {
  const accessToken = sessionStorage.getItem(referenceAccessTokenStorageKey);
  const accountId = sessionStorage.getItem(referenceAccountIdStorageKey);
  return accessToken && accountId ? { accessToken, accountId } : null;
}

export function clearReferenceSession(): void {
  sessionStorage.removeItem(referenceAccessTokenStorageKey);
  sessionStorage.removeItem(referenceAccountIdStorageKey);
}

/** Strip the credential-bearing URL fragment before any network request or render. */
export function takeCallbackAccessToken(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  return hash.get("access_token") || null;
}
