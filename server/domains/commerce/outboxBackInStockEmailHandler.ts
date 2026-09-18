import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { COMMERCE_PRODUCT_BACK_IN_STOCK_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import { resolveLocale, type Locale } from "../../../src/lib/i18n/resolveLocale.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import type { EmailBrand } from "../../../src/lib/brand/brandConfig.js";
import { marketingUnsubscribeFooter } from "../../../src/domains/communications/email/marketingFooter.js";
import { backInStockEmailContent } from "../../../src/domains/commerce/emails/backInStock.js";
import type {
  ConsentEvaluatorPort,
  MarketingEmailPort,
  ProductNameBySkuLookupPort,
  UnsubscribeUrlBuilder,
} from "./marketingEmailPorts.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";

export const OUTBOX_BACK_IN_STOCK_TEMPLATE_SLUG = "commerce-back-in-stock";

// Marketing alerts are RODO consent-gated; the unsubscribe footer uses this
// purpose so a one-click opt-out suppresses the right permission.
const MARKETING_PURPOSE = "marketing_newsletter";

const HANDLER_TIMEOUT_MS = 10_000;

// Frozen minimal parse: validate ONLY the two fields the handler consumes, with
// a schema owned HERE (not the live DB contract), so a producer-side change can
// never retro-DLQ in-flight events.
const payloadSubsetSchema = z
  .object({
    sku: z.string().trim().min(1),
    email: z.string().trim().email(),
  })
  .passthrough();

export interface BackInStockHandlerConfig {
  /** Public site origin for the product/configurator CTA. */
  baseUrl: string;
  email: {
    brand: EmailBrand;
    signoff: Record<Locale, string>;
    copyBrandName: string;
  };
}

export interface BackInStockNotificationPort {
  markNotified(input: {
    outboxEventId: string;
    notificationId: string | null;
    consentDecisionId: string | null;
    signal: AbortSignal;
  }): Promise<boolean>;
  closeSuppressed(input: {
    outboxEventId: string;
    notificationId: string | null;
    consentDecisionId: string | null;
    reason: string;
    signal: AbortSignal;
  }): Promise<boolean>;
}

// CTA goes to the localized configurator: the notification keys on a sku (text),
// but customer-facing product URLs are keyed on product slugs, so there is no
// stable sku -> product-page mapping. The configurator is the safe, always-valid
// landing page (see PR notes / links.ts EMAIL_ROUTES.configurator).
const CONFIGURATOR_PATH: Record<Locale, string> = {
  pl: "/skomponuj-pakiet",
  en: "/build-your-box",
};

function buildCtaUrl(baseUrl: string, locale: Locale): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${CONFIGURATOR_PATH[locale]}`;
}

function readNotificationId(row: OutboxEventRow): string | null {
  const value = row.metadata.subscriptionId;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function markNotificationSent(
  notificationPort: BackInStockNotificationPort | undefined,
  row: OutboxEventRow,
  consentDecisionId: string | null,
  signal: AbortSignal,
): Promise<"marked" | "missing" | "not_configured"> {
  if (!notificationPort) return "not_configured";
  const marked = await notificationPort.markNotified({
    outboxEventId: row.id,
    notificationId: readNotificationId(row),
    consentDecisionId,
    signal,
  });
  return marked ? "marked" : "missing";
}

async function closeNotificationSuppressed(
  notificationPort: BackInStockNotificationPort | undefined,
  row: OutboxEventRow,
  consentDecisionId: string | null,
  reason: string,
  signal: AbortSignal,
): Promise<"closed" | "missing" | "not_configured"> {
  if (!notificationPort) return "not_configured";
  const closed = await notificationPort.closeSuppressed({
    outboxEventId: row.id,
    notificationId: readNotificationId(row),
    consentDecisionId,
    reason,
    signal,
  });
  return closed ? "closed" : "missing";
}

export function createOutboxBackInStockEmailHandler(deps: {
  emailPort: MarketingEmailPort;
  consentEvaluator: ConsentEvaluatorPort;
  notificationPort?: BackInStockNotificationPort;
  // Resolves the sku to a customer-facing product name so the email never shows
  // a raw sku. Best-effort: optional, and a null result falls back to a generic
  // localized label inside backInStockEmailContent.
  productNameLookup?: ProductNameBySkuLookupPort;
  // Injected by the cron composition root; builds the absolute signed
  // unsubscribe URL so the handler never touches the HMAC token / secret.
  buildUnsubscribeUrl: UnsubscribeUrlBuilder;
  config: BackInStockHandlerConfig;
}): OutboxHandler {
  const { emailPort, consentEvaluator, notificationPort, productNameLookup, buildUnsubscribeUrl, config } = deps;

  return {
    eventType: COMMERCE_PRODUCT_BACK_IN_STOCK_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      const { sku, email } = parsed.data;

      // Consent gate FIRST — a suppressed/denied recipient is never sent to, and
      // the event is consumed (processed) so it does not retry forever.
      const consent = await consentEvaluator.evaluate({
        email,
        purpose: MARKETING_PURPOSE,
        recipientKind: "customer",
      });
      if (!consent.allowed) {
        try {
          const notification = await closeNotificationSuppressed(
            notificationPort,
            row,
            consent.decisionId,
            consent.reason,
            signal,
          );
          if (notification === "missing") return { kind: "retry", reason: "notification_close_missing" };
          if (notification === "not_configured") return { kind: "retry", reason: "notification_close_not_configured" };
          return {
            kind: "processed",
            detail: { skipped: "consent_blocked", reason: consent.reason, notification },
          };
        } catch (error) {
          return { kind: "retry", reason: truncateReason(`notification_close_failed: ${String(error)}`) };
        }
      }

      const alreadySent = await emailPort.findExistingSend(
        OUTBOX_BACK_IN_STOCK_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        try {
          const notification = await markNotificationSent(notificationPort, row, consent.decisionId, signal);
          if (notification === "missing") return { kind: "retry", reason: "notification_mark_missing" };
          return { kind: "processed", detail: { dedupe: "email_already_sent", notification } };
        } catch (error) {
          return { kind: "retry", reason: truncateReason(`notification_mark_failed: ${String(error)}`) };
        }
      }

      // Recipient has no order/country context here, so default to the PL locale
      // (the consent gate resolves the contact; copy stays PL unless a future
      // payload carries a locale hint).
      const locale = resolveLocale(null);

      // Resolve the customer-facing product name; a null/failed lookup leaves the
      // copy to fall back to a generic label (never the raw sku).
      let productName: string | null = null;
      if (productNameLookup) {
        try {
          productName = await productNameLookup.lookupNameBySku(sku);
        } catch {
          productName = null;
        }
      }

      const content = backInStockEmailContent(locale, {
        brandName: config.email.copyBrandName,
        sku,
        productName,
        ctaUrl: buildCtaUrl(config.baseUrl, locale),
      }, config.email.signoff[locale]);

      const unsubscribeUrl = await buildUnsubscribeUrl({
        email,
        purpose: MARKETING_PURPOSE,
        locale,
      });

      const rendered = renderEmail({
        brand: config.email.brand,
        locale,
        subject: content.subject,
        preheader: content.preheader,
        blocks: [...content.blocks, ...marketingUnsubscribeFooter(locale, unsubscribeUrl)],
      });

      const outcome = await emailPort.send({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        templateSlug: OUTBOX_BACK_IN_STOCK_TEMPLATE_SLUG,
        outboxEventId: row.id,
        decisionId: consent.decisionId,
        signal,
      });

      if (outcome.skipReason) {
        try {
          const notification = await closeNotificationSuppressed(
            notificationPort,
            row,
            consent.decisionId,
            outcome.skipReason,
            signal,
          );
          if (notification === "missing") return { kind: "retry", reason: "notification_close_missing" };
          if (notification === "not_configured") return { kind: "retry", reason: "notification_close_not_configured" };
          return { kind: "processed", detail: { skipped: outcome.skipReason, notification } };
        } catch (error) {
          return { kind: "retry", reason: truncateReason(`notification_close_failed: ${String(error)}`) };
        }
      }
      if (outcome.ok) {
        try {
          const notification = await markNotificationSent(notificationPort, row, consent.decisionId, signal);
          if (notification === "missing") return { kind: "retry", reason: "notification_mark_missing" };
          return { kind: "processed", detail: { resendId: outcome.resendId, notification } };
        } catch (error) {
          return { kind: "retry", reason: truncateReason(`notification_mark_failed: ${String(error)}`) };
        }
      }
      return mapResendOutcome(outcome);
    },
  };
}
