import type { OrderConversionStatusPort } from "../../../domains/commerce/marketingEmailPorts.js";

// Minimal Supabase shape this port needs (mirrors supabaseOrderRecipientPort).
export interface OrderConversionSupabaseClient {
  from(table: string): OrderConversionQueryBuilder;
}

interface OrderConversionQueryBuilder {
  select(columns: string): OrderConversionQueryBuilder;
  eq(column: string, value: unknown): OrderConversionQueryBuilder;
  limit(count: number): OrderConversionQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

// "Converted" = the order is no longer an open, unpaid draft. Inverts the
// abandoned-cart enqueue eligibility (status='draft' AND no commerce_payments
// row): the order converted if its status moved off 'draft' OR any payment row
// now exists (the customer may have paid via a different draft in the window).
export function createSupabaseOrderConversionStatusPort(
  client: OrderConversionSupabaseClient,
): OrderConversionStatusPort {
  return {
    async isConverted(orderUuid: string, _signal: AbortSignal): Promise<boolean> {
      const orderResult = await client
        .from("commerce_orders")
        .select("status")
        .eq("id", orderUuid)
        .maybeSingle();
      if (orderResult.error) {
        throw new Error(
          `outbox_conversion_order_read_failed: ${orderResult.error.message ?? orderResult.error.code ?? "unknown"}`,
        );
      }
      const order = orderResult.data as { status?: string | null } | null;
      // No order row (shouldn't happen post recipient-resolve) -> skip safely.
      if (!order || typeof order.status !== "string") return true;
      if (order.status !== "draft") return true;

      const paymentResult = await client
        .from("commerce_payments")
        .select("order_id")
        .eq("order_id", orderUuid)
        .limit(1)
        .maybeSingle();
      if (paymentResult.error) {
        throw new Error(
          `outbox_conversion_payment_read_failed: ${paymentResult.error.message ?? paymentResult.error.code ?? "unknown"}`,
        );
      }
      return paymentResult.data !== null;
    },
  };
}
