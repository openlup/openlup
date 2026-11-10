import type { AccountEvent, AccountProfile } from "./account.js";
export interface CustomerProfileUpdateRequest { idempotencyKey: string; firstName?: string | null; lastName?: string | null; phone?: string | null }
export interface CustomerProfileUpdateResponse { contractVersion: "customer.self_service.v1"; profile: AccountProfile }
export interface CustomerInvoiceCorrectionRequest { idempotencyKey: string; invoiceId: string; reason: string; requestedFields?: string[]; note?: string | null }
export interface CustomerInvoiceCorrectionResponse { contractVersion: "customer.billing.v1"; eventId: string }
export interface CustomerAccountMutationPort {
  updateProfile(userId: string, input: CustomerProfileUpdateRequest): Promise<CustomerProfileUpdateResponse | null>;
  requestInvoiceCorrection(userId: string, input: CustomerInvoiceCorrectionRequest): Promise<CustomerInvoiceCorrectionResponse | null>;
  readEvents(userId: string): Promise<AccountEvent[] | null>;
}
/** Validation values are selected by the adopter; a phone binding preserves its accepted input set. */
export interface CustomerAccountMutationPolicy {
  key: { min: number; max: number };
  name: { min: number; max: number };
  phone: { callingCode: string; localDigits: number };
  correction: { reasonMin: number; reasonMax: number; fieldsMax: number; fieldMax: number; noteMax: number };
}
export type CustomerAccountMutationRefusalCode = "customer_account_invalid_input" | "customer_principal_mismatch";
