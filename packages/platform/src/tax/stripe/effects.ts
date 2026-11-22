import { taxDigest } from "../digest.js";
import type { TaxCommitRequestV1, TaxCoverageInputV1, TaxQuoteInputV1, TaxQuoteRequestV1, TaxQuoteResultV1, TaxReverseRequestV1, TaxScopeV1 } from "../contracts/index.js";

export type Address = { line1: string; line2?: string; city: string; state?: string; postal_code: string; country: string };
type Charge = { amount: number; tax_code: string; tax_behavior: "exclusive" };
export type CalculationParams = {
  currency: string; tax_date: number; expand: string[];
  customer_details: { address: Address; address_source: "shipping" };
  ship_from_details: { address: Address }; shipping_cost?: Charge;
  line_items: (Charge & { reference: string; quantity: number; metadata: Record<string, string> })[];
};
export type PageParams = { limit: 100; starting_after?: string };
export interface StripeQuoteClient {
  readonly scope: Readonly<Pick<TaxScopeV1, "accountRef" | "mode">>;
  calculations: {
    create(params: CalculationParams, options: { idempotencyKey: string }): Promise<unknown>;
    listLineItems(id: string, params: PageParams & { expand: string[] }): Promise<unknown>;
  };
  registrations: { list(params: PageParams & { status: "all" }): Promise<unknown> };
}

export type Cell = TaxCoverageInputV1["required"][number];
export type Binding = Pick<Cell, "jurisdiction" | "taxKind" | "level" | "sourcing"> & {
  provider: { country: string; state: string | null; level: string; display_name: string }; taxType: string | null;
};
export type RegistrationBinding = Pick<Cell, "jurisdiction" | "taxKind"> & {
  country: string; state: string; type: "state_sales_tax" | "state_retail_delivery_fee"; complete: boolean;
};
export type FiscalAddress = TaxQuoteInputV1["destination"]["address"];
type Delivery = TaxQuoteInputV1["delivery"][number];

export interface StripeQuoteMarketPack {
  scope: TaxScopeV1;
  market: string;
  currency: string;
  policyRevision: string;
  classMapRevision: string;
  taxCodes: Readonly<Record<string, string>>;
  origins: Readonly<Record<string, FiscalAddress>>;
  subdivisions: Readonly<Record<string, Readonly<Record<string, string>>>>;
  delivery: readonly (Pick<Delivery, "carrierRef" | "serviceRef" | "separatelyStated" | "taxClass"> & {
    costIndependent: boolean; zeroAmount: boolean;
  })[];
  jurisdictions: readonly Binding[];
  registrations: readonly RegistrationBinding[];
  fees: readonly (Pick<Cell, "jurisdiction" | "taxKind"> & {
    feeKey: string; layout: "top_only" | "shipping_mirror"; refundRule: { ref: string; revision: string };
  })[];
}

export type Final = Extract<TaxQuoteResultV1, { kind: "final" }>;
type WriteOptions = { idempotencyKey: string };
type WireMoney = { amount: number; amount_tax: number };
type Reference = { reference: string; metadata: { openlup_request_digest: string } };
export type SaleParams = Reference & { calculation: string; posted_at: number };
export type ReversalParams = Reference & {
  original_transaction: string; mode: "full" | "partial";
  line_items?: (WireMoney & { original_line_item: string; reference: string })[];
  shipping_cost?: WireMoney;
};
export interface Client extends StripeQuoteClient {
  calculations: StripeQuoteClient["calculations"] & { retrieve(id: string): Promise<unknown> };
  transactions: {
    createFromCalculation(params: SaleParams, options: WriteOptions): Promise<unknown>;
    createReversal(params: ReversalParams, options: WriteOptions): Promise<unknown>;
    retrieve(id: string): Promise<unknown>;
    listLineItems(id: string, params: PageParams): Promise<unknown>;
  };
}

export type Accepted = {
  request: TaxQuoteRequestV1; result: Final; closed: boolean;
};
type Unit = {
  kind: "line" | "shipping"; originalPositionRef: string; postedPositionRef: string; taxCode: string;
  remainingNetMinor: number; remainingTaxMinor: number;
};
// A ready reservation authorizes its original body and key only until the host's proven send deadline.
type Send = { kind: "ready"; before: string } | { kind: "unknown" };
type Reservation = {
  /** Persist the value returned by makeStripeTaxRequestDigest before dispatch. */
  requestDigest: string;
  send: Send;
};
export type SaleReservation = Reservation & {
  capture: { ref: string; currency: string; payableMinor: number; capturedAt: string };
};
export type RefundReservation = Reservation & {
  /** Immutable verified refund and remaining balances captured when this reversal was reserved. */
  refundEvidenceRef: string;
  original: { id: string; scope: TaxScopeV1; currency: string; taxDate: string;
    payableMinor: number; refundedMinor: number; units: readonly Unit[] };
};
type RequestBinding =
  | { operation: "commit"; request: TaxCommitRequestV1; capture: SaleReservation["capture"] }
  | { operation: "reverse"; request: TaxReverseRequestV1; refundEvidenceRef: string; original: RefundReservation["original"] };

/**
 * Derive the requestDigest to persist with the verified capture or refund reservation before dispatch.
 * Binds the port request and immutable facts, including the posted-line mapping for a refund.
 * Intent and send state can change during recovery. This helper performs no I/O.
 * @beta
 * @experimental
 */
export function makeStripeTaxRequestDigest(binding: RequestBinding): string {
  const { operation, request } = binding;
  // Preserve descriptors so canonicalization rejects accessors and extra fields remain bound.
  const descriptors = Object.getOwnPropertyDescriptors<object>(request);
  delete descriptors.intent;
  const body: unknown = Object.create(Object.getPrototypeOf(request), descriptors);
  const facts = operation === "commit" ? binding.capture : { refundEvidenceRef: binding.refundEvidenceRef, original: binding.original };
  return taxDigest(operation, [body, facts]);
}

export interface Effects {
  /** These callbacks read authoritative records. The host serializes sends and persists effects and local closes. */
  accepted(ref: TaxCommitRequestV1["calculationRef"]): Accepted | undefined;
  commit(transactionRef: string): SaleReservation | undefined;
  reverse(reversalRef: TaxReverseRequestV1["reversalRef"]): RefundReservation | undefined;
  /** Return a positive observation keyed by the exact provider reference.
   * It is ol-tax-<operation>- followed by the SHA-256 of canonical JSON for
   * [platform.tax.<operation>.v1, [operation, installationRef, scope, saleOrRefundRef]].
   */
  findTransactionIdByReference(reference: string): string | undefined;
}
