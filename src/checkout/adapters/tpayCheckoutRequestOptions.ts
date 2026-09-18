import type { CheckoutRequest } from "@/domains/commerce/checkoutContracts";
import { getCustomerAuthPort } from "@/lib/auth/customerAuthPortFactory";
import type { BffRequestOptions } from "@/lib/bff/client";

/**
 * The request options a checkout submit carries — today, only whether it proves a
 * session.
 *
 * Two different reasons to attach the same header, and they must not be collapsed:
 *
 * - **Saved BLIK needs one to work at all.** `blik_one_click` and
 *   `blik_recurring_saved` charge a stored mandate, so a submit without a session
 *   is refused here rather than sent.
 * - **Every other flow attaches one when there happens to be a session**, and is
 *   perfectly fine without. That half exists because the persist path resolves its
 *   client row by the typed e-mail: without a proven subject it may not rewrite an
 *   account-linked row, which would silently stop a logged-in buyer's own details
 *   from being saved. ⛔ It must never become a refusal — guest checkout is the
 *   primary acquisition flow and carries no session by definition.
 *
 * (The name is historical: this began as a Tpay-only concern and now decides the
 * header for every rail.)
 */
export async function checkoutRequestOptionsForTpay(
  tpayPatch: Pick<CheckoutRequest, "paymentProvider" | "paymentExecution"> | null,
): Promise<BffRequestOptions> {
  const execution = tpayPatch?.paymentExecution;
  const savedBlik =
    execution?.provider === "tpay" &&
    (execution.flow === "blik_one_click" || execution.flow === "blik_recurring_saved");

  const accessToken = (await getCustomerAuthPort().getSession())?.accessToken;
  if (!accessToken) {
    if (savedBlik) throw new Error("saved_blik_session_required");
    return {};
  }

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  return { headers };
}
