import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { isInAppBrowser } from "@/lib/inAppBrowser";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";

/** Buyer-minted recovery link. Authority is the continuation cookie, never a body. */
export const CHECKOUT_PAYMENT_LINK_PATH = "/api/bff/commerce/checkout-payment-link";

/**
 * One CONFIRMATION per page session, module-level rather than per-component.
 *
 * The three mount points below replace each other as the step changes state, so
 * a component-scoped latch would reset with them and greet a buyer who already
 * has the e-mail with an untouched "send me a link". That is how one tap becomes
 * four.
 *
 * ⛔ It latches the SENTENCE, never the control. The route dedupes per order per
 * ten-minute bucket precisely so "someone who genuinely lost the first mail can
 * ask again inside the same checkout", and a client latch that removes the button
 * cancels exactly that promise: a buyer whose e-mail never arrived is left facing
 * a panel with nothing on it. Re-tapping inside the bucket costs nothing, because
 * the server is idempotent by design.
 */
let linkSentThisPageSession = false;

/** Test-only reset of the per-page-session latch. */
export function resetFinishInBrowserHatchForTests(): void {
  linkSentThisPageSession = false;
}

export interface FinishInBrowserHatchProps {
  /** Spacing the host owns; the hatch never assumes its neighbours. */
  className?: string;
}

/**
 * The way out of an embedded webview, for a buyer who has an order and an
 * attempt but cannot get the card through.
 *
 * ⛔ **Renders for nobody else.** Six of the nine card checkouts that died in the
 * 30 days to 2026-09-02 came from an in-app browser, and none of them reached
 * the provider at all. In a real browser there is nothing here to escape from,
 * so the control is absent rather than merely unhelpful.
 *
 * The request carries NO BODY. Everything the route needs is in the
 * `HttpOnly` continuation cookie, which is why `credentials: "same-origin"` is
 * the one option that matters here; a failure is a neutral retry line, never an
 * excuse to ask the buyer to retype an address we already hold.
 *
 * Theme: `current`-relative colours only, because the same control renders on
 * the dark configurator shell and the cream account shell.
 */
export function FinishInBrowserHatch({ className }: FinishInBrowserHatchProps) {
  const { t } = useTranslation("checkout");
  const inApp = isInAppBrowser();
  const [sent, setSent] = useState(linkSentThisPageSession);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!inApp) return;
    // Fires with the render, not with the tap: how many stuck buyers were even
    // offered the way out is the denominator the follow-up monitor needs.
    reportCheckoutClientEvent("escape_hatch", "shown");
  }, [inApp]);

  if (!inApp) return null;

  async function requestLink() {
    if (sending) return;
    const diagnostic = startRecoveryHatchDiagnostic();
    setSending(true);
    setFailed(false);
    reportCheckoutClientEvent("escape_hatch", "requested");
    try {
      const response = await fetch(CHECKOUT_PAYMENT_LINK_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        diagnostic?.settle(response.status >= 400 && response.status < 500 ? "rejected" : "failed");
        setFailed(true);
        return;
      }
      diagnostic?.settle("succeeded");
      reportCheckoutClientEvent("escape_hatch", "sent");
      linkSentThisPageSession = true;
      setSent(true);
    } catch {
      diagnostic?.settle("transport_uncertain");
      // A webview that refuses the request looks exactly like one that failed
      // it, and the buyer is told the same true thing either way: try again.
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      role="region"
      aria-label={t("checkout:finishInBrowser.prompt")}
      data-testid="finish-in-browser"
      className={`mt-6 space-y-2 border-t border-current/15 pt-4 text-center ${className ?? ""}`.trim()}
    >
      <p className="font-body text-sm opacity-70">{t("checkout:finishInBrowser.prompt")}</p>
      {sent ? (
        <div role="status" aria-live="polite" data-testid="finish-in-browser-sent">
          <p className="font-body text-sm">{t("checkout:finishInBrowser.sent")}</p>
          <p className="mt-2 font-body text-xs-plus opacity-70">
            {t("checkout:finishInBrowser.hint")}
          </p>
        </div>
      ) : null}
      {/* Same node in both states, re-labelled: the confirmation above says the
          link is out, and this stays reachable for the buyer it never reached. */}
      <button
        type="button"
        data-testid="finish-in-browser-action"
        onClick={() => void requestLink()}
        disabled={sending}
        className="focus-ring inline-flex min-h-11 items-center justify-center rounded-control border border-current px-5 font-body text-sm font-semibold transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t(sent ? "checkout:finishInBrowser.resend" : "checkout:finishInBrowser.action")}
      </button>
      {failed ? (
        <p role="status" aria-live="polite" data-testid="finish-in-browser-failed" className="font-body text-sm opacity-70">
          {t("checkout:finishInBrowser.failed")}
        </p>
      ) : null}
    </div>
  );
}

type RecoveryHatchDiagnosticCode = "succeeded" | "rejected" | "failed" | "transport_uncertain";

function startRecoveryHatchDiagnostic(): { settle: (code: RecoveryHatchDiagnosticCode) => void } | null {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return null;
    const report = (phase: "attempted" | "settled", code: "observed" | RecoveryHatchDiagnosticCode): void => {
      void reporter.then((loadedReporter) => {
        try {
          loadedReporter?.reportCustomerJourneyDiagnostic({
            action: "checkout_recovery_hatch", phase, code, clientActionKey,
          });
        } catch {
          // Diagnostics never change the escape hatch.
        }
      }).catch(() => {});
    };
    report("attempted", "observed");
    return { settle: (code) => report("settled", code) };
  } catch {
    return null;
  }
}
