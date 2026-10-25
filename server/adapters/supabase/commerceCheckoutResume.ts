import { createSupabaseCommerceCheckoutResumePort as createPort, type CommerceCheckoutResumeClient } from "@openlup/platform/commerce/server";
import { checkoutResumeDraftSchema, type CheckoutResumeSectionId, type CheckoutResumeDraftState, type CheckoutResumeDraft } from "../../../src/domains/commerce/checkoutResumeContracts.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceCheckoutResumeDraftPort } from "../../../src/domains/commerce/ports.js";
export function createSupabaseCommerceCheckoutResumePort(client: SupabaseClient): CommerceCheckoutResumeDraftPort {
  return createPort<CheckoutResumeSectionId, CheckoutResumeDraftState, CheckoutResumeDraft>(client as unknown as CommerceCheckoutResumeClient, checkoutResumeDraftSchema);
}
