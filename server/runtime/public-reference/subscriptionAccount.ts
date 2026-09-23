import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { sendBffError, sendBffSuccess } from "../../_lib/bff/response.js";
import { z } from "../../../src/lib/validation/zod.js";
import { createCustomerClients, createCustomerClient, createCustomerServiceClient, authenticateCustomerUser, type CustomerSelfServiceEnv } from "../../_lib/customer-domain/auth.js";
import { readBearerToken } from "../../_lib/admin-domain/auth.js";
import { checkAndRecordCustomerMagicLinkAttempt, extractClientIp, type CustomerMagicLinkRateLimitClient } from "../../_lib/rate-limit/customerMagicLinkRateLimit.js";
import { padResponseTime } from "../../_lib/timing.js";
import { reconcileAccountForPrincipal } from "../../domains/auth/reconcileAccountForPrincipal.js";
import { createSupabaseAccountLinkStore } from "../../adapters/supabase/accountLinkStore.js";
import { createCustomerAccountHandler } from "../../domains/customers/customerAccountHandler.js";
import { createSupabaseCustomerSelfServicePort } from "../../adapters/supabase/customerSelfService.js";
import { createCustomerDeliveryAlignmentRowsReader } from "../../adapters/subscriptionDeliveryAlignmentGateway.js";
import { createCustomerSubscriptionActionHandler } from "../../domains/customers/customerSubscriptionActionHandler.js";
import { applyCustomerSubscriptionAction } from "../../adapters/supabase/customerSubscriptionAction.js";

export type ReferenceHandler = (req: HttpRequest, res: HttpResponse) => Promise<unknown> | unknown;
const requestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(160) }).strict();

/** Mounted only by the validated disposable profile, never the static server. */
export function createReferenceAccountHandlers(env: CustomerSelfServiceEnv, origin: string) {
  const service = createCustomerServiceClient(env);
  return {
    requestSignIn: async (req: HttpRequest, res: HttpResponse) => {
      const request = requestSchema.safeParse(req.body);
      if (!request.success) return sendBffError(res, "BAD_REQUEST", "Enter a valid email address");
      const started = Date.now();
      const decision = await checkAndRecordCustomerMagicLinkAttempt({
        client: service as unknown as CustomerMagicLinkRateLimitClient,
        ip: extractClientIp(req.headers), email: request.data.email,
      });
      if (!decision.allowed && decision.reason === "rpc_error") {
        await padResponseTime(started, 400);
        return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Sign-in is temporarily unavailable");
      }
      if (decision.allowed) {
        // Auth sends only to the disposable installation's captured SMTP service.
        // No admin-generated session and no caller-controlled redirect or metadata.
        try {
          const { error } = await createCustomerClient(env, null).auth.signInWithOtp({
            email: request.data.email,
            options: { shouldCreateUser: true, emailRedirectTo: `${origin}/account/auth/callback` },
          });
          if (error) throw error;
        } catch {
          await padResponseTime(started, 400);
          return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Sign-in is temporarily unavailable");
        }
      }
      await padResponseTime(started, 400);
      sendBffSuccess(res, { accepted: true });
    },
    reconcile: async (req: HttpRequest, res: HttpResponse) => {
      const token = readBearerToken(req);
      if (!token) return sendBffError(res, "UNAUTHORIZED", "Sign in first");
      const { data, error } = await createCustomerClient(env, token).auth.getUser(token);
      if (error || !data.user) return sendBffError(res, "UNAUTHORIZED", "Sign in again");
      // Only Auth's confirmation fact is authority. User-editable metadata is not.
      const result = await reconcileAccountForPrincipal(createSupabaseAccountLinkStore(service), {
        principalId: data.user.id, email: data.user.email ?? null,
        emailVerified: Boolean(data.user.email_confirmed_at),
      });
      if (!result.ok) return sendBffError(res, "FORBIDDEN", "This verified account cannot be linked", { details: { code: result.code } });
      sendBffSuccess(res, { accountId: result.accountId, created: result.created, linked: result.linked });
    },
    account: async (req: HttpRequest, res: HttpResponse) => {
      const token = readBearerToken(req);
      const clients = createCustomerClients(env, token);
      return createCustomerAccountHandler({
        accountPort: createSupabaseCustomerSelfServicePort(clients, createCustomerDeliveryAlignmentRowsReader(clients.serviceClient)),
        authenticateUser: () => authenticateCustomerUser(clients.customerClient, token),
      })(req, res);
    },
    renewal: async (req: HttpRequest, res: HttpResponse) => {
      // This profile advertises only renewal-date changes; no dormant actions leak in.
      if (!req.body || typeof req.body !== "object" || !("action" in req.body) || req.body.action !== "slide_next_cycle") {
        return sendBffError(res, "BAD_REQUEST", "Only renewal-date changes are available in this profile");
      }
      const token = readBearerToken(req);
      const customer = createCustomerClient(env, token);
      return createCustomerSubscriptionActionHandler({
        authenticateUser: () => authenticateCustomerUser(customer, token),
        subscriptionActionPort: { applyAction: (userId, input) => applyCustomerSubscriptionAction({
          serviceClient: service, genericBundleActionsEnabled: false, userId, input,
        }) },
      })(req, res);
    },
  };
}
