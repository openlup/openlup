import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  authReconcileResponseSchema,
  type AuthReconcileResponse,
} from "@/domains/auth/contracts";

const PATH = "/api/bff/customers/reconcile-account";

/**
 * Ensures the authenticated principal has a linked, functional account. Called
 * once per new session before the profile read, so a brand-new social user is
 * provisioned (and an existing customer is relinked) before CustomerProtectedRoute
 * checks readiness. Throws `BffClientError` (carrying the domain code in
 * `details.code`) on the dedup-conflict / no-email outcomes.
 */
export function reconcileCustomerAccount(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AuthReconcileResponse> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return requestBff(PATH, authReconcileResponseSchema, {
    ...options,
    method: "POST",
    body: {},
    headers,
  });
}
