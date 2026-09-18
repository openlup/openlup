import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceMoney } from "../../../src/domains/commerce/types.js";

export interface SubscriptionLineRef {
  lineId: string | null;
  variantId: string;
  quantity: number;
  isAddon: boolean;
  sortOrder: number;
}

export interface RepricedLine {
  lineId: string | null;
  quoteLine: unknown;
}

export interface RepricedEditQuote {
  repricedLines: RepricedLine[];
  quoteHash: string;
  expectedTemplateVersion: number;
}

export interface RecipeSetReprice {
  recipeLines: Array<{ variantId: string; qty: number; quoteLine: unknown }>;
  addonLines: Array<{ lineId?: string; variantId?: string; qty?: number; quoteLine: unknown }>;
  rewriteAddonLines?: boolean;
  compositionConstraint?: CreateQuoteRequest["sizeConstraint"];
  cadenceDays: number;
  expectedTemplateVersion: number;
  quoteHash: string;
  currentRecurringPrice?: CommerceMoney;
  newRecurringPrice?: CommerceMoney;
}

export interface PackageEditLine {
  variantId: string;
  qty: number;
  quoteLine: unknown;
}

export interface PackageEditQuote {
  currentRecurringPrice: CommerceMoney;
  newRecurringPrice: CommerceMoney;
  delta: CommerceMoney;
  quoteHash: string;
  recipeLines: PackageEditLine[];
  addonLines: PackageEditLine[];
  cadenceDays: number;
  expectedTemplateVersion: number;
}

export interface SubscriptionRepricer {
  repriceForEdit(input: {
    subscriptionId: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<RepricedEditQuote | null>;
  repriceRecipeSet(input: {
    subscriptionId: string;
    action: string;
    payload: Record<string, unknown>;
    sourceAction?: string;
  }): Promise<RecipeSetReprice | null>;
  previewPackageEdit(input: {
    subscriptionId: string;
    payload: Record<string, unknown>;
  }): Promise<PackageEditQuote>;
}
