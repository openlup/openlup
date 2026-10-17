import {
  createCheckoutPaymentContinuationCodec,
  type CheckoutCookieResponse,
  type CheckoutPaymentContinuationMinter,
} from "../../domains/commerce/checkoutPaymentContinuationCredential.js";
export function composeCheckoutPaymentContinuationMinter(): CheckoutPaymentContinuationMinter | undefined {
  const codec = createCheckoutPaymentContinuationCodec(
    process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET,
  );
  if (!codec) return undefined;
  return (res, input) => appendSetCookie(res, codec.issue(input).setCookie);
}

export function logCheckoutAccountLinkResult(result:
  | { ok: false; code: string }
  | { ok: true; created: boolean; alreadyLinked: boolean; adminSelfLink: boolean }
): void {
  if (result.ok === false) {
    console.warn("checkout_account_link_refused", JSON.stringify({ code: result.code }));
    return;
  }
  console.info("checkout_account_link_succeeded", JSON.stringify({
    created: result.created,
    alreadyLinked: result.alreadyLinked,
    adminSelfLink: result.adminSelfLink,
  }));
}

function appendSetCookie(res: CheckoutCookieResponse, cookie: string): void {
  const current = res.getHeader?.("Set-Cookie");
  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current.map(String), cookie]);
  } else if (typeof current === "string") {
    res.setHeader("Set-Cookie", [current, cookie]);
  } else {
    res.setHeader("Set-Cookie", cookie);
  }
}
