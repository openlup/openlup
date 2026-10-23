import type { InvoiceProof, InvoiceUnsupported } from "./provider.js";
/** One immutable balance item, never unique by batch+payment alone.
 * Carrier: accountingControlContracts settlement + payout balance transaction ID.
 * Null links and bankReceivedAt are facts; settlement is not an invoice gate.
 * @consumer Host payout item recorder.
 */
export interface InvoiceSettlementItem {
  readonly requestKey: string;
  readonly providerRef: string;
  readonly batchRef: string;
  readonly itemRef: string;
  readonly providerPaymentRef: string;
  readonly paymentIntentRef: string | null;
  readonly paymentRef: string | null;
  readonly invoiceRef: string | null;
  readonly grossMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly currency: string;
  readonly status: "matched" | "unmatched" | "mismatch" | "bank_pending";
  readonly bankReceivedAt: string | null;
  readonly proof: InvoiceProof;
}
type ItemScope = Pick<InvoiceSettlementItem, "providerRef" | "batchRef" | "itemRef" | "providerPaymentRef">;
export type InvoiceSettlementResult =
  | { readonly kind: "found"; readonly scope: ItemScope; readonly paymentIntentRef: string | null; readonly paymentRef: string | null; readonly invoiceRef: string | null; readonly proof: InvoiceProof }
  | { readonly kind: "absent"; readonly scope: ItemScope; readonly evidence: InvoiceProof & { readonly exact: true; readonly complete: true; readonly scope: ItemScope } }
  | { readonly kind: "recorded"; readonly itemRef: string; readonly settlementItemRef: string; readonly replayed: boolean }
  | { readonly kind: "conflict"; readonly itemRef: string; readonly code: "identity_mismatch" | "money_mismatch" }
  | { readonly kind: "unknown"; readonly itemRef: string; readonly code: "unknown" }
  | InvoiceUnsupported;
/** Host recorder/resolver owns richer item identity. Unsupported before any write
 * when a native batch/payment row cannot represent distinct items or nullable links.
 * @consumer Host payout item recorder/resolver.
 */
export interface InvoiceSettlementPort {
  record(item: InvoiceSettlementItem): Promise<Exclude<InvoiceSettlementResult, { kind: "found" | "absent" }>>;
  resolve(input: ItemScope): Promise<Exclude<InvoiceSettlementResult, { kind: "recorded" | "conflict" }>>;
}
