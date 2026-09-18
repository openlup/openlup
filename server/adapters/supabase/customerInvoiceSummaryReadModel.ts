import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerOrdersListResponse } from "../../../src/domains/customers/accountV2Contracts.js";
import {
  resolveAccountingDocumentHistory,
  type AccountingDocumentHistoryEntry,
} from "../../../src/domains/accounting/contracts.js";
import { deriveCustomerDocumentDeliveryStatus } from "../../domains/customers/customerInvoiceDocumentStatus.js";
import { accountingPreviewTestPdfEligible } from "../../_lib/config/featureFlags.js";

type Row = Record<string, unknown>;
type Order = CustomerOrdersListResponse["orders"][number];
type InvoiceSummary = Order["invoice"];
type InvoiceDocument = Order["invoiceDocuments"][number];

export interface CustomerInvoiceHistorySummary {
  invoice: InvoiceSummary;
  invoiceDocuments: InvoiceDocument[];
}

export async function readCustomerInvoiceSummaries(
  serviceClient: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, CustomerInvoiceHistorySummary>> {
  const map = new Map<string, CustomerInvoiceHistorySummary>();
  if (orderIds.length === 0) return map;
  const { data, error } = await serviceClient
    .from("accounting_invoices")
    // `currency` is selected beside `total_gross_cents` because the two are one fact:
    // an amount without its denomination is a number, and this read model publishes it
    // to a customer. The column has always been there (`NOT NULL CHECK (char_length =
    // 3)`); this SELECT simply never asked for it, which is how the stamp below came to
    // be a constant.
    .select("id, order_id, invoice_ref, status, blocked_reason, provider_kind, provider_invoice_id, provider_invoice_number, ksef_number, ksef_status, document_kind, email_status, total_gross_cents, currency, correction_of_invoice_id, correction_status, metadata, updated_at, created_at")
    .in("order_id", orderIds)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as Row[];
  const invoiceIds = rows.map((row) => text(row.id));
  const [deliveryOutboxes, operations] = await Promise.all([
    readInvoiceDeliveryOutboxes(serviceClient, invoiceIds),
    readInvoiceOperations(serviceClient, invoiceIds),
  ]);
  const rowsByOrder = groupBy(rows, "order_id");

  for (const orderId of orderIds) {
    const history = resolveAccountingDocumentHistory({
      invoices: rowsByOrder.get(orderId) ?? [],
      operations,
      deliveryOutboxes,
      providerArtifactEligible,
    });
    if (history.documents.length === 0) continue;
    map.set(orderId, {
      invoice: history.current ? toInvoiceSummary(history.current) : null,
      invoiceDocuments: history.documents.map(toInvoiceDocument),
    });
  }
  return map;
}

async function readInvoiceDeliveryOutboxes(serviceClient: SupabaseClient, invoiceIds: string[]): Promise<Row[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await serviceClient
    .from("accounting_invoice_delivery_outbox")
    .select("invoice_id, status, metadata, processed_at, created_at")
    .in("invoice_id", invoiceIds)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Row[];
}

async function readInvoiceOperations(serviceClient: SupabaseClient, invoiceIds: string[]): Promise<Row[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await serviceClient
    .from("accounting_invoice_operations")
    .select("invoice_id, operation, provider_ref, payload, created_at")
    .in("invoice_id", invoiceIds)
    .in("operation", ["correction_issued", "provider_email_sent"])
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Row[];
}

function toInvoiceSummary(document: AccountingDocumentHistoryEntry): NonNullable<InvoiceSummary> {
  return {
    invoiceId: document.invoiceId,
    orderId: document.orderId,
    invoiceRef: document.invoiceRef,
    status: document.status,
    providerInvoiceNumber: document.providerInvoiceNumber,
    ksefNumber: document.ksefNumber,
    ksefStatus: document.ksefStatus,
    documentDeliveryStatus: documentDeliveryStatus(document),
    totalGross: money(document.totalGrossMinor, document.currency),
    issuedAt: document.issuedAt,
    downloadAvailable: document.downloadAvailable,
    downloadUrl: document.downloadAvailable
      ? invoiceDownloadUrl(document.invoiceId, document.artifact)
      : null,
    createdAt: document.createdAt,
  };
}

function toInvoiceDocument(document: AccountingDocumentHistoryEntry): InvoiceDocument {
  return {
    ...toInvoiceSummary(document),
    documentKey: document.documentKey,
    role: document.role,
    artifact: document.artifact,
    isCurrent: document.isCurrent,
    totalGross: document.totalGrossMinor === null
      ? null
      : money(document.totalGrossMinor, document.currency),
  };
}

function documentDeliveryStatus(document: AccountingDocumentHistoryEntry) {
  return deriveCustomerDocumentDeliveryStatus({
    blockedReason: document.blockedReason,
    status: document.status,
    documentKind: document.documentKind,
    ksefStatus: document.ksefStatus,
    emailStatus: document.emailState,
    outboxStatus: null,
    downloadAvailable: document.downloadAvailable,
  });
}

function providerArtifactEligible(providerKind: string): boolean {
  return (
    ["fakturownia", "fakturownia_test"].includes(providerKind)
    && (providerKind !== "fakturownia_test" || accountingPreviewTestPdfEligible())
  );
}

function invoiceDownloadUrl(invoiceId: string, artifact: "invoice" | "correction"): string {
  const params = new URLSearchParams({ invoiceId });
  if (artifact === "correction") params.set("artifact", artifact);
  return `/api/bff/customers/invoices/download?${params.toString()}`;
}

/**
 * Denominates an invoice total in **the currency the invoice was issued in**, read
 * from `accounting_invoices.currency` and carried here on the history entry.
 *
 * An invoice is the highest-consequence money on this platform and the least eligible
 * for a live answer: it is a document of record, and its currency was decided the day
 * it was written. A stamp that read the deployment's settlement profile would restate
 * a customer's accounting history every time an operator changed the shop's currency.
 *
 * The column is `NOT NULL CHECK (char_length = 3)`, so a currency-less document cannot
 * reach here; if one did, `text()` yields `""` and `platformCurrencySchema` inside
 * `customerInvoiceDocumentSchema` refuses the response by name rather than letting a
 * bare number through to a customer.
 */
function money(value: number | null, currency: string) {
  return { amountMinor: value ?? 0, currency };
}

function groupBy(rows: Row[], column: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const key = text(row[column]);
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  return map;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
