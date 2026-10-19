import { createBackInStockContentFactory } from "@openlup/platform/communications/contracts";
import { commerceEmailContent } from "#commerce-email-content";

export type { BackInStockEmailVars, BackInStockEmailContent } from "@openlup/platform/communications/contracts";
export const { backInStockEmailContent } = createBackInStockContentFactory({ commerceEmailContent });
