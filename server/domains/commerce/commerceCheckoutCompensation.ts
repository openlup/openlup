export interface CheckoutCompensationPort {
  releaseOrderReservations(input: {
    idempotencyKey: string;
    orderId: string;
    reason: string;
  }): Promise<{ releasedCount: number }>;
  cancelUnstartedPromotionOrder(input: {
    idempotencyKey: string;
    orderId: string;
    reason: string;
  }): Promise<{ cancelled: boolean }>;
  cancelAbandonedOrder(input: {
    idempotencyKey: string;
    orderId: string;
    reason: string;
  }): Promise<{ cancelled: boolean }>;
}

export async function tryCompensate(
  port: CheckoutCompensationPort,
  idempotencyKey: string,
  orderId: string,
  options?: { cancellationReason?: string },
): Promise<void> {
  const promotionCancellationReason = options?.cancellationReason
    ?? "checkout_orchestration_failed_before_runtime";
  const abandonedCancellationReason = options?.cancellationReason
    ?? "checkout_orchestration_failed_before_provider_dispatch";
  try {
    await port.releaseOrderReservations({
      idempotencyKey: `${idempotencyKey}:checkout-compensation`,
      orderId,
      reason: "checkout_orchestration_failed",
    });
  } catch {
    console.warn("checkout_compensation_release_failed", JSON.stringify({ orderId }));
  }
  let promotionOrderCancelled = false;
  try {
    const result = await port.cancelUnstartedPromotionOrder({
      idempotencyKey,
      orderId,
      reason: promotionCancellationReason,
    });
    promotionOrderCancelled = result.cancelled;
  } catch {
    console.warn("checkout_promotion_draft_compensation_failed", JSON.stringify({ orderId }));
  }
  if (promotionOrderCancelled) return;

  // The promotion-specific cleanup deliberately refuses an order once a local
  // payment intent exists. A deterministic pre-dispatch runtime failure is still
  // safe to cancel: the caller withholds the order id for every uncertain or
  // in-flight provider attempt, so reaching this fallback proves no PSP dispatch
  // may have taken money. Use the canonical aggregate cleanup to close the order,
  // payment intent and provisional subscription instead of leaving pending ghosts.
  try {
    await port.cancelAbandonedOrder({
      idempotencyKey,
      orderId,
      reason: abandonedCancellationReason,
    });
  } catch {
    console.warn("checkout_abandoned_order_compensation_failed", JSON.stringify({ orderId }));
  }
}
