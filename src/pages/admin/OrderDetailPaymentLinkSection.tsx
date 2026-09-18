import { useEffect, useState } from "react";
import { Check, Copy, Link2, Mail } from "lucide-react";
import type { TFunction } from "i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { bffErrorMessage } from "@/lib/bff/errorMessage";
import { localizedPath } from "@/lib/i18nRoutes";
import { resolveLocale } from "@/lib/i18n/resolveLocale";
import {
  ADMIN_COMMERCE_ORDER_PAYMENT_LINK_REFUSALS,
  type AdminCommerceOrderPaymentLinkRefusal,
  type AdminCommerceOrderPaymentLinkRequest,
  type AdminCommerceOrderPaymentLinkResponse,
  type OmsOrderDetail,
} from "@/domains/commerce/omsContracts";
import { ActionButton, DetailSection } from "./OrderDetailBlocks";
import { formatDate } from "./ordersPageUtils";

export type GeneratePaymentLink = (
  accessToken: string,
  request: AdminCommerceOrderPaymentLinkRequest,
) => Promise<AdminCommerceOrderPaymentLinkResponse>;

/**
 * The order states an operator may mint a link for.
 *
 * ⚠️ Cosmetic only. The server decides — it re-reads the order and refuses with a
 * named reason — and this list exists so the button is not offered on an order
 * that visibly cannot use it. `draft` is absent because a draft has no amount to
 * pay yet, and everything from `paid` onwards is absent because the money is in.
 */
export const PAYMENT_LINK_ORDER_STATUSES = [
  "pending_payment", "failed", "expired", "cancelled",
] as const;

type LinkState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "done"; result: AdminCommerceOrderPaymentLinkResponse }
  | { status: "refused"; reason: AdminCommerceOrderPaymentLinkRefusal | null; detail: string };

/**
 * Reads the refusal out of an error, in whichever shape the BFF hands it over.
 *
 * The route settles on `details.reason` from the closed vocabulary, but the raw
 * server code is also a legitimate shape here, so both are accepted. Anything it
 * cannot name returns null and the operator gets the honest generic sentence with
 * the underlying message, never a silent nothing.
 */
export function paymentLinkRefusalReason(error: unknown): AdminCommerceOrderPaymentLinkRefusal | null {
  const candidates: string[] = error instanceof Error ? [error.message] : [];
  const details = error && typeof error === "object" && "details" in error
    ? (error as { details?: unknown }).details
    : null;
  if (details && typeof details === "object") {
    for (const field of ["reason", "code"]) {
      const value = (details as Record<string, unknown>)[field];
      if (typeof value === "string") candidates.push(value);
    }
  }
  return candidates.find((value): value is AdminCommerceOrderPaymentLinkRefusal =>
    (ADMIN_COMMERCE_ORDER_PAYMENT_LINK_REFUSALS as readonly string[]).includes(value)) ?? null;
}

/**
 * Builds the absolute link the operator pastes into a support reply.
 *
 * The origin comes from the window the operator is looking at, so the link always
 * points at the deployment they generated it on — correct on staging and on
 * production with no origin configured anywhere. The language follows the same
 * rule the recovery emails follow (`resolveLocale` over the shipping country), so
 * a customer does not get a link in a language their email was not written in.
 */
export function composePaymentLinkUrl(detail: OmsOrderDetail, token: string): string {
  const locale = resolveLocale(detail.shippingAddress?.country ?? null);
  const path = localizedPath("checkoutRecovery", locale) ?? "";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${path}?token=${encodeURIComponent(token)}`;
}

export function OrderDetailPaymentLinkSection({
  accessToken,
  detail,
  generatePaymentLink,
  isPending,
  locale,
  t,
}: {
  accessToken: string | undefined;
  detail: OmsOrderDetail;
  generatePaymentLink: GeneratePaymentLink;
  isPending: boolean;
  locale: string;
  t: TFunction;
}) {
  const [state, setState] = useState<LinkState>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setState({ status: "idle" });
    setCopied(false);
  }, [detail.orderId]);

  if (!(PAYMENT_LINK_ORDER_STATUSES as readonly string[]).includes(detail.status)) return null;

  const busy = isPending || state.status === "submitting";

  // One command, two ways for the link to travel. The copy flow sends the request
  // it always sent — no `delivery` field at all — so an operator who only wants a
  // link to paste cannot accidentally cause an email to a customer. Refusals are
  // read the same way for both, because the server refuses for the same reasons.
  const submit = async (delivery?: "email") => {
    if (!accessToken) return;
    setState({ status: "submitting" });
    setCopied(false);
    try {
      const request = delivery ? { orderId: detail.orderId, delivery } : { orderId: detail.orderId };
      setState({ status: "done", result: await generatePaymentLink(accessToken, request) });
    } catch (error) {
      setState({ status: "refused", reason: paymentLinkRefusalReason(error), detail: bffErrorMessage(error) });
    }
  };

  const copy = async (url: string) => {
    // Not every operator browser exposes the async clipboard (it needs a secure
    // context), and a copy button that throws would look like the link failed.
    // The field beside it is selectable, so falling back to "nothing happened"
    // still leaves the operator a working path.
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <DetailSection
      testId="admin-oms-payment-link-section"
      title={t("admin:adminOms.paymentLink.title")}
      subtitle={t("admin:adminOms.paymentLink.subtitle")}
      icon={Link2}
    >
      <div className="rounded-md border border-teal/20 bg-teal/5 p-3 text-sm text-text-muted">
        <p>{t("admin:adminOms.paymentLink.whatItDoes")}</p>
        {/* Said before the click, not after: the operator is about to invalidate
            whatever link they may already have sent this customer. */}
        <p className="mt-1" data-testid="admin-oms-payment-link-invalidates">
          {t("admin:adminOms.paymentLink.invalidatesPrevious")}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton
          icon={Link2}
          label={t("admin:adminOms.paymentLink.submit")}
          hint={t("admin:adminOms.paymentLink.hint")}
          testId="admin-oms-action-generate-payment-link"
          disabled={!accessToken || busy}
          disabledReason={busy ? t("admin:adminOms.eligibility.action_pending") : null}
          onClick={() => void submit()}
        />
        <ActionButton
          icon={Mail}
          label={t("admin:adminOms.paymentLink.sendEmail")}
          hint={t("admin:adminOms.paymentLink.sendEmailHint")}
          testId="admin-oms-action-email-payment-link"
          disabled={!accessToken || busy}
          disabledReason={busy ? t("admin:adminOms.eligibility.action_pending") : null}
          onClick={() => void submit("email")}
        />
      </div>

      {state.status === "refused" ? (
        <div className="mt-3 text-sm text-warm-coral" data-testid="admin-oms-payment-link-refusal" role="status">
          <p className="font-medium">{t("admin:adminOms.paymentLink.blocked.title")}</p>
          <p className="mt-1">
            {state.reason
              ? t(`admin:adminOms.paymentLink.blocked.${state.reason}`)
              : t("admin:adminOms.paymentLink.blocked.unknown", { detail: state.detail })}
          </p>
        </div>
      ) : null}

      {state.status === "done" ? (
        <div className="mt-3 text-sm" data-testid="admin-oms-payment-link-result" role="status">
          <p className="font-medium text-teal-dark">{t("admin:adminOms.paymentLink.done")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={composePaymentLinkUrl(detail, state.result.token)}
              aria-label={t("admin:adminOms.paymentLink.urlLabel")}
              data-testid="admin-oms-payment-link-url"
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 border-warm-sand bg-white text-xs text-teal-dark"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="admin-oms-payment-link-copy"
              onClick={() => void copy(composePaymentLinkUrl(detail, state.result.token))}
              className="gap-2 border-warm-sand text-teal-dark"
            >
              {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              {copied ? t("admin:adminOms.paymentLink.copied") : t("admin:adminOms.paymentLink.copy")}
            </Button>
          </div>
          {/* Only after the server confirms the link reached the delivery rail.
              Saying it on the copy flow, or on an enqueue that failed, would have
              the operator promise the customer an email nobody is sending. */}
          {state.result.emailQueued ? (
            <p className="mt-2 text-teal-dark" data-testid="admin-oms-payment-link-emailed">
              {t("admin:adminOms.paymentLink.emailQueued")}
            </p>
          ) : null}
          <p className="mt-2 text-text-muted" data-testid="admin-oms-payment-link-expiry">
            {t("admin:adminOms.paymentLink.expiresAt", { date: formatDate(state.result.expiresAt, locale) })}
          </p>
        </div>
      ) : null}
    </DetailSection>
  );
}
