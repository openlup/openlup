import type { SupabaseClient } from "@supabase/supabase-js";
import { CUSTOMER_BILLING_CONTRACT_VERSION } from "../../../src/domains/customers/accountV2Contracts.js";
import { accountingPreviewTestPdfEligible } from "../../_lib/config/featureFlags.js";
import type {
  CustomerBillingProfilesPort,
  CustomerInvoiceDownloadPort,
  CustomerInvoiceCorrectionPort,
  CustomerOrdersPort,
} from "../../domains/customers/ports.js";
import {
  deleteBillingProfile,
  listBillingProfiles,
  upsertBillingProfile,
} from "./customerBillingProfileModels.js";
import {
  readCustomerOrderDetail,
  readCustomerOrderSummaries,
} from "./customerOrderHistoryReadModels.js";
import { createSupabaseCustomerAccountReadStore } from "./customerAccountReadStore.js";
import { createSupabaseCustomerOrderHistoryReadStore } from "./customerOrderHistoryReadStore.js";

interface Deps {
  customerClient: SupabaseClient;
  serviceClient: SupabaseClient;
}

type Row = Record<string, unknown>;

export function createSupabaseCustomerAccountV2Port({ customerClient, serviceClient }: Deps) {
  const accountStore = createSupabaseCustomerAccountReadStore(customerClient);
  const orderStore = createSupabaseCustomerOrderHistoryReadStore(customerClient, serviceClient);
  const readClient = (userId: string) => readLinkedClient(customerClient, userId);
  return {
    async listBillingProfiles(userId) {
      const client = await readClient(userId);
      return client ? listBillingProfiles(accountStore, text(client.id)) : null;
    },
    async upsertBillingProfile(userId, input) {
      const client = await readClient(userId);
      return client ? upsertBillingProfile(customerClient, accountStore, text(client.id), input) : null;
    },
    async deleteBillingProfile(userId, input) {
      const client = await readClient(userId);
      return client ? deleteBillingProfile(customerClient, accountStore, text(client.id), input) : null;
    },
    async listOrders(userId, input) {
      const client = await readClient(userId);
      return client
        ? readCustomerOrderSummaries(orderStore, text(client.id), input.limit)
        : null;
    },
    async getOrderDetail(userId, orderId) {
      const client = await readClient(userId);
      return client
        ? readCustomerOrderDetail(orderStore, text(client.id), orderId)
        : null;
    },
    async requestInvoiceCorrection(userId, input) {
      const client = await readClient(userId);
      if (!client) return null;
      const invoice = await readOwnedInvoice(serviceClient, customerClient, text(client.id), input.invoiceId);
      if (!invoice) return null;
      const { data, error } = await customerClient
        .from("customer_account_events")
        .insert({
          client_id: text(client.id),
          event_type: "customer.invoice_correction_requested",
          entity_type: "accounting_invoice",
          entity_id: input.invoiceId,
          payload: {
            idempotencyKey: input.idempotencyKey,
            invoiceRef: text(invoice.invoice_ref),
            reason: input.reason,
            requestedFields: input.requestedFields ?? [],
            note: input.note ?? null,
          },
        })
        .select("id")
        .single();
      if (error) throw error;
      return { contractVersion: CUSTOMER_BILLING_CONTRACT_VERSION, eventId: text(data.id) };
    },
    async getInvoiceDownloadTicket(userId, invoiceId, artifact = "invoice") {
      const client = await readClient(userId);
      if (!client) return null;
      const invoice = await readOwnedInvoice(serviceClient, customerClient, text(client.id), invoiceId);
      if (!invoice) return null;
      const providerArtifact = resolveProviderArtifact(invoice, artifact);
      if (!providerArtifact) return null;
      return {
        invoiceId: text(invoice.id),
        invoiceRef: artifact === "correction"
          ? providerArtifact.providerInvoiceNumber ?? text(invoice.invoice_ref)
          : text(invoice.invoice_ref),
        providerKind: text(invoice.provider_kind),
        providerInvoiceId: providerArtifact.providerInvoiceId,
        providerInvoiceNumber: providerArtifact.providerInvoiceNumber,
        artifact,
        fileName: invoiceFileName(providerArtifact.providerInvoiceNumber ?? text(invoice.invoice_ref)),
      };
    },
  } satisfies CustomerBillingProfilesPort & CustomerOrdersPort & CustomerInvoiceCorrectionPort & CustomerInvoiceDownloadPort;
}

async function readOwnedInvoice(
  serviceClient: SupabaseClient,
  customerClient: SupabaseClient,
  clientId: string,
  invoiceId: string,
) {
  const { data: invoice, error: invoiceError } = await serviceClient
    .from("accounting_invoices")
    .select("id, order_id, invoice_ref, status, blocked_reason, provider_kind, provider_invoice_id, provider_invoice_number, correction_of_invoice_id, correction_status, metadata")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invoiceError) throw invoiceError;
  if (!invoice) return null;
  const { data: order, error: orderError } = await customerClient
    .from("commerce_orders")
    .select("id")
    .eq("id", text((invoice as Row).order_id))
    .eq("client_id", clientId)
    .maybeSingle();
  if (orderError) throw orderError;
  return order ? (invoice as Row) : null;
}

async function readLinkedClient(customerClient: SupabaseClient, userId: string) {
  const { data, error } = await customerClient
    .from("clients")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as Row | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveProviderArtifact(row: Row, artifact: "invoice" | "correction") {
  const providerKind = text(row.provider_kind);
  const providerEligible = (
    ["fakturownia", "fakturownia_test"].includes(providerKind) &&
    (providerKind !== "fakturownia_test" || accountingPreviewTestPdfEligible()) &&
    nullableText(row.blocked_reason) === null
  );
  if (!providerEligible) return null;
  if (artifact === "correction") {
    const metadata = record(row.metadata);
    const providerInvoiceId = nullableText(metadata.correctionProviderInvoiceId);
    if (!providerInvoiceId || !["issued", "accepted"].includes(text(row.correction_status))) return null;
    return {
      providerInvoiceId,
      providerInvoiceNumber: nullableText(metadata.correctionProviderInvoiceNumber),
    };
  }
  const providerInvoiceId = nullableText(row.provider_invoice_id);
  if (!providerInvoiceId || !["issued", "accepted", "corrected"].includes(text(row.status))) return null;
  return {
    providerInvoiceId,
    providerInvoiceNumber: nullableText(row.provider_invoice_number),
  };
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function invoiceFileName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "faktura";
  return `${safe}.pdf`;
}
