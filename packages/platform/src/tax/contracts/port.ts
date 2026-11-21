import type {
  TaxCalculationRefV1, TaxCapabilitiesV1, TaxCloseReasonV1, TaxCloseResultV1, TaxCommitRequestV1, TaxCommitResultV1,
  TaxFiscalValidityRequestV1, TaxFiscalValidityResultV1, TaxQuoteRequestV1, TaxQuoteResultV1, TaxReverseRequestV1,
  TaxReverseResultV1,
} from "./types.js";

export const TAX_CALCULATION_CONTRACT_VERSION = "platform.tax-calculation.v1";

export interface TaxCalculationPortV1 {
  readonly contractVersion: typeof TAX_CALCULATION_CONTRACT_VERSION;
  capabilities(): TaxCapabilitiesV1;
  quote(request: TaxQuoteRequestV1): Promise<TaxQuoteResultV1>;
  readFiscalValidity(request: TaxFiscalValidityRequestV1): Promise<TaxFiscalValidityResultV1>;
  closeCalculation(ref: TaxCalculationRefV1, reason: TaxCloseReasonV1, key: string): Promise<TaxCloseResultV1>;
  commit(request: TaxCommitRequestV1): Promise<TaxCommitResultV1>;
  reverse(request: TaxReverseRequestV1): Promise<TaxReverseResultV1>;
}

export type TaxCalculationPort = TaxCalculationPortV1;
