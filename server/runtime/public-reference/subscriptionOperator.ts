import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { authorizeCommerceAdminWithUser, createAdminAuthClient, readBearerToken } from "../../_lib/admin-domain/auth.js";
import { createCustomerServiceClient, type CustomerSelfServiceEnv } from "../../_lib/customer-domain/auth.js";
import { z } from "../../../src/lib/validation/zod.js";
import type { ReferenceHandler } from "./subscriptionAccount.js";

const requestSchema = z.object({ orderId: z.string().uuid() }).strict();
const orderSchema = z.object({
  id: z.string().uuid(), client_id: z.string().uuid(), mode: z.literal("subscription_cycle"),
  status: z.string().min(1), subscription_id: z.string().uuid().nullable(),
});
const paymentSchema = z.object({ status: z.string().min(1) });
const subscriptionSchema = z.object({
  id: z.string().uuid(), status: z.string().min(1), next_cycle_at: z.string().nullable(),
});

/** One authenticated human operator's exact-order, persisted-state readback. */
export function createReferenceOperatorHandler(env: CustomerSelfServiceEnv): ReferenceHandler {
  const service = createCustomerServiceClient(env);
  return async (req: HttpRequest, res: HttpResponse) => {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const token = readBearerToken(req);
    if (!token) return sendBffError(res, "UNAUTHORIZED", "Operator session required");
    let authorization;
    try {
      authorization = await authorizeCommerceAdminWithUser(createAdminAuthClient(env, token), token);
    } catch {
      return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operator authorization failed");
    }
    if (!authorization.ok) return sendBffError(res, authorization.code, authorization.message);
    if (authorization.isMachineActor !== false) return sendBffError(res, "FORBIDDEN", "Human operator required");

    const request = requestSchema.safeParse(req.query ?? {});
    if (!request.success) return sendBffError(res, "BAD_REQUEST", "One valid orderId is required");
    try {
      const { orderId } = request.data;
      const orderResult = await service.from("commerce_orders")
        .select("id, client_id, mode, status, subscription_id")
        .eq("id", orderId).eq("mode", "subscription_cycle").maybeSingle();
      if (orderResult.error) throw orderResult.error;
      if (!orderResult.data) return sendBffError(res, "NOT_FOUND", "Subscription order not found");
      const order = orderSchema.safeParse(orderResult.data);
      if (!order.success) return sendBffError(res, "INVALID_RESPONSE", "Invalid order readback");

      const paymentResult = await service.from("commerce_payments")
        .select("status").eq("order_id", orderId)
        .order("created_at", { ascending: false }).limit(1);
      if (paymentResult.error) throw paymentResult.error;
      const payment = paymentResult.data?.[0] == null ? null : paymentSchema.safeParse(paymentResult.data[0]);
      if (payment && !payment.success) return sendBffError(res, "INVALID_RESPONSE", "Invalid payment readback");

      let subscription: z.infer<typeof subscriptionSchema> | null = null;
      if (order.data.subscription_id) {
        const subscriptionResult = await service.from("subscriptions")
          .select("id, status, next_cycle_at")
          .eq("id", order.data.subscription_id).eq("client_id", order.data.client_id).maybeSingle();
        if (subscriptionResult.error) throw subscriptionResult.error;
        if (subscriptionResult.data) {
          const parsed = subscriptionSchema.safeParse(subscriptionResult.data);
          if (!parsed.success) return sendBffError(res, "INVALID_RESPONSE", "Invalid subscription readback");
          subscription = parsed.data;
        }
      }
      sendBffSuccess(res, {
        order: { orderId: order.data.id, status: order.data.status },
        payment: payment ? { status: payment.data.status } : null,
        subscription: subscription ? {
          subscriptionId: subscription.id, status: subscription.status,
          nextRenewalAt: subscription.next_cycle_at,
        } : null,
      });
    } catch {
      return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operator readback failed");
    }
  };
}
