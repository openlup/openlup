import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";
import {
  createCustomerClients,
  readBearerToken,
  readCustomerSelfServiceEnv,
} from "./shared.js";

/**
 * Composition root for the customer self-service routes that build the full
 * {customerClient, serviceClient} bundle (account, billing-profiles,
 * communication-preferences, orders, payment-methods, pets, profile).
 *
 * Collapses the env-read + env-null guard + client construction those routes
 * share verbatim. On a missing env it OWNS the failure response (`INTERNAL` /
 * "Supabase environment is not configured") and returns `null`.
 *
 * Deliberately does NOT run the per-route feature-flag guard: those vary per
 * route (customerSelfServiceEnabled / customerPaymentMethodsEnabled / ...) with
 * per-route messages and details, and must run FIRST at the call-site. Routes
 * that read a different env or use a singular client (me, magic-link,
 * delivery-preferences, preferences, reconcile-account, addresses) are NOT
 * served here — folding them in would erase their anon-vs-service RLS
 * distinction.
 */
export function composeCustomerSelfService(
  req: VercelRequest,
  res: VercelResponse,
):
  | {
      accessToken: ReturnType<typeof readBearerToken>;
      clients: ReturnType<typeof createCustomerClients>;
    }
  | null {
  const env = readCustomerSelfServiceEnv();
  if (!env) {
    sendBffError(res, "INTERNAL", "Supabase environment is not configured");
    return null;
  }
  const accessToken = readBearerToken(req);
  return { accessToken, clients: createCustomerClients(env, accessToken) };
}
