export type CommerceCurrency = string;
export type CommerceTaxCountry = string;
export type CommerceTaxCategory = string;
export type CommerceTaxLegalBasis = string;

export interface CommerceMoney {
  amountMinor: number;
  currency: CommerceCurrency;
}

export interface CartLineInput {
  sku: string;
  quantity: number;
  variantId?: string;
  modeAtLine?: "one_time" | "subscription";
  isAddon?: boolean;
}

export interface CommerceTaxProfile {
  included: true;
  country: CommerceTaxCountry;
  category: CommerceTaxCategory;
  vatRateBps: number;
  legalBasis: CommerceTaxLegalBasis;
}

export interface CommerceTaxBreakdown extends CommerceTaxProfile {
  netAmount: CommerceMoney;
  vatAmount: CommerceMoney;
  grossAmount: CommerceMoney;
}

