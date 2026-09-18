import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  accountingInvoiceIssueRequestSchema,
  accountingInvoiceIssueResponseSchema,
  adminAccountingOrderSummaryResponseSchema,
  accountingProviderSyncEventSchema,
  accountingProviderSyncResponseSchema,
  paymentProviderSettlementRecordSchema,
  paymentProviderSettlementResponseSchema,
  invoiceDataLookupRequestSchema,
  invoiceDataLookupResponseSchema,
  type AccountingInvoiceIssueRequest,
  type AccountingInvoiceIssueResponse,
  type AdminAccountingOrderSummaryResponse,
  type AccountingProviderSyncEvent,
  type AccountingProviderSyncResponse,
  type InvoiceDataLookupRequest,
  type InvoiceDataLookupResponse,
  type PaymentProviderSettlementRecord,
  type PaymentProviderSettlementResponse,
} from "./invoiceContracts";

export function lookupInvoiceData(
  request: InvoiceDataLookupRequest,
  options: BffRequestOptions = {},
): Promise<InvoiceDataLookupResponse> {
  return requestBff(
    "/api/bff/accounting/invoice-data-lookup",
    invoiceDataLookupResponseSchema,
    {
      ...options,
      method: "POST",
      body: invoiceDataLookupRequestSchema.parse(request),
    },
  );
}

export function requestAccountingInvoiceIssue(
  accessToken: string,
  request: AccountingInvoiceIssueRequest,
  options: BffRequestOptions = {},
): Promise<AccountingInvoiceIssueResponse> {
  return requestBff(
    "/api/bff/admin/accounting/invoices/issue-request",
    accountingInvoiceIssueResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: accountingInvoiceIssueRequestSchema.parse(request),
    },
  );
}

export function getAdminAccountingOrderSummary(
  accessToken: string,
  orderId: string,
  options: BffRequestOptions = {},
): Promise<AdminAccountingOrderSummaryResponse> {
  return requestBff(
    `/api/bff/admin/accounting/order-summary?${new URLSearchParams({ orderId })}`,
    adminAccountingOrderSummaryResponseSchema,
    { ...options, method: "GET", headers: authHeaders(accessToken, options) },
  );
}

export function recordAccountingProviderSyncEvent(
  accessToken: string,
  event: AccountingProviderSyncEvent,
  options: BffRequestOptions = {},
): Promise<AccountingProviderSyncResponse> {
  return requestBff(
    "/api/bff/admin/accounting/provider-sync",
    accountingProviderSyncResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: accountingProviderSyncEventSchema.parse(event),
    },
  ) as Promise<AccountingProviderSyncResponse>;
}

export function recordPaymentProviderSettlement(
  accessToken: string,
  settlement: PaymentProviderSettlementRecord,
  options: BffRequestOptions = {},
): Promise<PaymentProviderSettlementResponse> {
  return requestBff(
    "/api/bff/admin/accounting/settlements",
    paymentProviderSettlementResponseSchema,
    {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: paymentProviderSettlementRecordSchema.parse(settlement),
    },
  ) as Promise<PaymentProviderSettlementResponse>;
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
