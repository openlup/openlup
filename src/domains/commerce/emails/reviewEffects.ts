import { createReviewEffectsContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

export type { ReviewEffectsEmailVars, ReviewEffectsEmailContent } from "@openlup/platform/communications/contracts";
export const { reviewEffectsEmailContent } = createReviewEffectsContentFactory({ commerceEmailContent, marketingUnsubscribeFooter });
