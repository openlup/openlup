import { createReviewRequestContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";

export type { ReviewRequestEmailVars, ReviewRequestEmailContent } from "@openlup/platform/communications/contracts";
export const { reviewRequestEmailContent } = createReviewRequestContentFactory({ commerceEmailContent, marketingUnsubscribeFooter });


/** Build the absolute review-form URL for the locale. */
export function reviewFormUrl(baseUrl: string, locale: Locale, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = locale === "en" ? "/review/" : "/recenzja/";
  return `${base}${path}${encodeURIComponent(token)}`;
}
