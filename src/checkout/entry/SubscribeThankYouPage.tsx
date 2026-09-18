import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { getCommerceOrderRecap } from "@/domains/commerce/commerceClient";
import type { OrderRecapResponse } from "@/domains/commerce/orderRecapContracts";
import { formatCurrencyMinor, moneyLang } from "@/lib/currency/formatMinor";
import { useLocalizedPath } from "@/lib/i18nRoutes";

/**
 * The platform's neutral checkout terminal — the last page of the subscribe
 * funnel `docs/plan/oss-subscription-axis-audit.md` §1.6 gap **a1** left open.
 *
 * a1 published an entry and two payment terminals and routed the SUCCESS case to
 * a route key whose only component lives in a withheld tree. A published
 * deployment therefore charged the customer and then handed them a route it does
 * not mount. This is that missing page, and `#checkout-terminal-route` is what
 * makes the published payment adapter and the published recovery hook find it
 * without changing where a deployment with its own terminal sends people.
 *
 * ⛔ Scaffolding on purpose, in the same sense as `SubscribeEntryPage` beside it:
 * the twenty per cent an adopter replaces. It reads no deployment vocabulary and
 * authors no receipt of its own — the numbers come from the SAME authoritative
 * server recap (`/api/bff/commerce/order-recap`) the platform already owns, so
 * this page cannot disagree with the order the customer paid for. Local
 * storage is deliberately not consulted: the customer may be returning from a
 * bank in a different browser, and a terminal that only works on the device that
 * started the payment is not a terminal.
 *
 * The V2 contract is requested rather than the newest one because V2 is the
 * neutral shape — reference, lines, totals, recurrence. The later revisions add
 * offer presentation a deployment negotiates for itself.
 */
export default function SubscribeThankYouPage() {
  const { i18n } = useTranslation("common");
  const localizedPath = useLocalizedPath();
  const [params] = useSearchParams();
  const orderRef = params.get("order");
  const orderId = params.get("orderId");
  const clientId = params.get("clientId");
  const [recap, setRecap] = useState<OrderRecapResponse | null>(null);

  useEffect(() => {
    if (!orderId || !clientId) return;
    let cancelled = false;
    // A recap that does not answer is not a reason to doubt the payment: the
    // customer reached this page because the payment control plane reported
    // `paid`. The confirmation stands and only the detail is withheld.
    void getCommerceOrderRecap({ orderId, clientId })
      .then((response) => {
        if (!cancelled) setRecap(response);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orderId, clientId]);

  if (!orderRef && !orderId) {
    return (
      <main className="min-h-screen bg-cream px-6 py-16 text-ink">
        <p aria-live="polite" className="font-body" data-testid="subscribe-terminal-unidentified">
          This link carries no order, so there is nothing to confirm here.
        </p>
      </main>
    );
  }

  const money = { currency: recap?.totals.total.currency ?? "", locale: moneyLang(i18n.language) };
  const reference = recap?.orderNumber ?? orderRef;

  return (
    <main className="min-h-screen bg-cream px-6 py-12 text-ink" data-testid="subscribe-thank-you">
      <section className="mx-auto max-w-2xl rounded-card border border-ink/10 bg-white p-6 shadow-sm md:p-10">
        <p className="mono-label text-accent-teal">CONFIRMED</p>
        <h1 className="mt-3 font-display text-4xl font-semibold">Payment received</h1>
        <p className="mt-2 font-body text-ink/65">
          The order is placed and a confirmation is on its way by email.
        </p>

        {reference && (
          <p className="mt-6 font-body text-sm text-ink/65">
            Order reference{" "}
            <span className="font-mono text-ink" data-testid="subscribe-terminal-reference">
              {reference}
            </span>
          </p>
        )}

        {recap && (
          <div className="mt-8 rounded-control border border-ink/10 p-4">
            <h2 className="font-display text-2xl font-semibold">What was ordered</h2>
            <ul className="mt-4 space-y-2">
              {recap.items.map((line, index) => (
                <li
                  className="flex justify-between gap-4 font-body text-ink/80"
                  key={`${line.title}-${index}`}
                >
                  <span>
                    {line.title} × {line.quantity}
                  </span>
                  <span className="font-mono">
                    {formatCurrencyMinor(line.total.amountMinor, {
                      ...money,
                      currency: line.total.currency,
                    })}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 flex justify-between gap-4 border-t border-ink/10 pt-4 font-body font-semibold">
              <span>Total</span>
              <span className="font-mono" data-testid="subscribe-terminal-total">
                {formatCurrencyMinor(recap.totals.total.amountMinor, money)}
              </span>
            </p>
            {recap.mode === "subscription" && recap.cadenceDays !== null && (
              <p className="mt-4 font-body text-sm text-ink/65" data-testid="subscribe-terminal-cadence">
                Repeats every {recap.cadenceDays} days. Change or stop it any time from your
                account.
              </p>
            )}
          </div>
        )}

        <Link
          className="pill-btn mt-8 inline-flex h-12 items-center justify-center bg-teal px-6 text-sm font-semibold text-cfg-on-accent transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          to={localizedPath("customerDashboard")}
        >
          Go to your account
        </Link>
      </section>
    </main>
  );
}
