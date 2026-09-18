import { useCallback, useEffect, useRef } from "react";

import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";

/**
 * WHY THE BUYER LEFT THE PAYMENT STEP, which no server row can answer.
 *
 * The 2026-08-27 card dead-end report ended at a wall: fourteen card payments
 * died without a single issuer refusal, and the last observable fact was a buyer
 * on the payment step and then gone. Whether the tab closed or the buyer pressed
 * back changes which defect is worth fixing, and nothing recorded the difference.
 *
 * Lives here rather than inside `PaymentForm` for two reasons, in that order:
 * window/document listener plumbing is not a form component's job, and
 * `PaymentForm.tsx` stands at its 300-line cap, which is shrink-only.
 *
 * Returns the committed-state setter for the host to raise at confirm time and
 * lower only when Stripe proves the call stopped before provider dispatch.
 * ⛔ THAT GUARD IS THE WHOLE DESIGN, not a refinement of it. `pagehide`
 * fires on EVERY departure — a 3DS bounce to the provider and a completed
 * purchase both leave the page — so an ungated listener would report abandonment
 * most loudly exactly when the payment worked, and the code would be muted
 * within a day. Keying on the same instant the resume marker already uses reuses
 * a notion the payment path owns rather than inventing a second, disagreeing one.
 *
 * The two codes are genuinely different events, not one event twice:
 * `pagehide`/`visibilitychange` mean the DOCUMENT went away, while `popstate` is
 * an in-app history move that unloads nothing. The sink's per-session dedup caps
 * each at one report, so a buyer who backs out and then closes the tab reports
 * both once, which is the true story.
 */
export function usePaymentStepDeparture(): (value: boolean) => void {
  // A ref rather than state on purpose: the listeners must see the CURRENT
  // answer at the instant the page is going away, and a re-render is not
  // guaranteed to have happened by then.
  const committed = useRef(false);

  useEffect(() => {
    const reportDeparture = (code: "payment_step_abandoned" | "payment_step_exited_back") => {
      if (committed.current) return;
      reportCheckoutClientEvent("payment_form", code);
    };
    // ⛔ Two listeners, two conditions, and they are NOT interchangeable.
    // `pagehide` means the document is going away, full stop — it must report
    // unconditionally, because `visibilityState` is still `visible` during
    // `pagehide` in several browsers and reusing the visibility check here would
    // silence the ordinary "buyer left the site" case entirely.
    const onPageHide = () => reportDeparture("payment_step_abandoned");
    // `visibilitychange` is the half that fires in a mobile webview — where the
    // reported failures came from — and it fires in BOTH directions, so it only
    // means departure once the document is actually hidden.
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      reportDeparture("payment_step_abandoned");
    };
    const onPop = () => reportDeparture("payment_step_exited_back");
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("popstate", onPop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return useCallback((value: boolean) => {
    committed.current = value;
  }, []);
}
