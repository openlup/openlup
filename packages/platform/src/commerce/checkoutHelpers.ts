export interface OrderDeliveryContactInput {
  recipientName: string;
  contactEmail: string;
  contactPhone: string;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  country: string;
  selectedDelivery?: unknown;
  deliveryInstructions?: string | null;
  courierInstructions?: string | null;
}

/**
 * Complete order-owned delivery authority. Profile and address-book rows can
 * keep serving defaults, but fulfillment must not reconstruct an order's
 * recipient from those mutable records after checkout.
 */
export function buildOrderDeliveryContact(
  input: OrderDeliveryContactInput,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: "checkout_submission",
    revision: 1,
    recipientName: input.recipientName.trim(),
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    postalCode: input.postalCode,
    country: input.country,
    selectedDelivery: input.selectedDelivery ?? null,
    deliveryInstructions: input.deliveryInstructions ?? null,
    courierInstructions: input.courierInstructions ?? null,
  };
}

export function uuidFromOrderRef(orderRef: string): string {
  return orderRef.replace(/^order_/, "");
}

export function messageOf(error: unknown, stage: string): string {
  return error instanceof Error ? `${stage}: ${error.message}` : `${stage}: unknown`;
}
