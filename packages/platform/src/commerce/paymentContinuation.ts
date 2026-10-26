import { z } from "zod";

export const checkoutContinuationJourneyIdSchema = z.string().regex(/^checkout:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
/** Shared client/server lifetime; terminal payment status still invalidates continuation. */
export const CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS = 45 * 60;
