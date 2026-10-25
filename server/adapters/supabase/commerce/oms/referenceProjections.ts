import { omsOrderSearchMatchSchema } from "../../../../../src/domains/commerce/omsContracts.js";
import { CommerceOmsPersistenceError, ORDER_HEADER_MONEY_COLUMNS } from "@openlup/platform/commerce";
import type { CommerceOmsStore,OmsAccountingInvoiceRow,OmsManagedReadProjections,OmsOrderRow } from "@openlup/platform/commerce/contracts";
import { mapPet } from "../../../../../src/domains/commerce/omsReadModelHelpers.js";
import type { OmsPetRow } from "../../../../../src/domains/commerce/omsReadModelRows.js";
import { referenceOmsProjections,toNeutralInvoice } from "../../../../../src/domains/commerce/omsReferenceBinding.js";
import { buildOmsFulfillmentHealth } from "../../../../domains/commerce/omsFulfillmentHealth.js";
import { buildOmsFulfillmentHealthDigests } from "../../../../domains/commerce/omsFulfillmentHealthDigest.js";
import { readOmnipackInboundEvents } from "./inboundEvents.js";
import { readFulfillmentOperations,readOmnipackDispatchRefs,readOmnipackStatusEvidence,readProviderAttempts,readReleasedProviderExceptionHolds } from "./providerEvidence.js";
import { readProviderStockCurrent } from "./providerStock.js";
function hostClient(store: CommerceOmsStore) { return { from: store.query, rpc: store.rpc }; }
export const referenceOmsManagedProjections: OmsManagedReadProjections = {
  model: referenceOmsProjections,
  // Host Zod inference runs without strictNullChecks; these schemas still require nullable keys at runtime.
  queueMatchSchema: omsOrderSearchMatchSchema as NonNullable<OmsManagedReadProjections["queueMatchSchema"]>,
  orderColumns: `id, order_number, client_id, status, mode, ${ORDER_HEADER_MONEY_COLUMNS}, metadata, created_at, updated_at, subscription_id, subscription_cycle_id, shipping_address_id, pet_id, source_kind, source_order_ref, sales_channels(slug)`,
  invoiceColumns: "id, order_id, invoice_ref, status, provider_kind, provider_invoice_number, ksef_status, total_gross_cents, currency, blocked_reason, updated_at",
  mapInvoice: value => toNeutralInvoice(value as Parameters<typeof toNeutralInvoice>[0]) as OmsAccountingInvoiceRow,
  projectQueue: value => {
    if (!value || typeof value !== "object") return value;
    const raw = value as Record<string, unknown>;
    const counts = raw.summaryCounts as Record<string, unknown> | undefined;
    if (!counts) return value;
    const { omnipackDispatchedNotPicked, ...rest } = counts;
    return { ...raw, summaryCounts: { ...rest, providerDispatchedNotPicked: omnipackDispatchedNotPicked ?? 0 } };
  },
  readIdentity: async (store, orders, view) => {
    const hostOrders = orders as Array<OmsOrderRow & { pet_id?: string | null }>;
    const ids = [...new Set(hostOrders.flatMap(row => row.pet_id ? [row.pet_id] : []))];
    if (!ids.length) return Object.fromEntries(orders.map(order => [order.id, { pet: null }]));
    const query = store.query("pets").select("id, name, pet_type, breed, age_label, weight_kg");
    const result = view === "detail" ? await query.eq("id", ids[0]).maybeSingle() : await query.in("id", ids);
    if (result.error) throw new CommerceOmsPersistenceError(view === "detail" ? "Commerce OMS related detail read failed" : "Commerce OMS related list read failed");
    const rows = (Array.isArray(result.data) ? result.data : result.data ? [result.data] : []) as OmsPetRow[];
    return Object.fromEntries(hostOrders.map(order => [order.id, { pet: mapPet(rows.find(row => row.id === order.pet_id) ?? null) }]));
  },
  readFulfillmentOperations: (store, ids) => readFulfillmentOperations(hostClient(store), ids),
  readProviderDispatchRefs: (store, ids) => readOmnipackDispatchRefs(hostClient(store), ids),
  readProviderStatusEvidence: (store, ids) => readOmnipackStatusEvidence(hostClient(store), ids),
  readProviderAttempts: (store, ids) => readProviderAttempts(hostClient(store), ids),
  readReleasedProviderExceptionHolds: (store, ids) => readReleasedProviderExceptionHolds(hostClient(store), ids),
  readProviderStockCurrent: (store, items) => readProviderStockCurrent(hostClient(store), items),
  readInboundEvents: (store, input) => readOmnipackInboundEvents(hostClient(store), input),
  buildHealth: input => buildOmsFulfillmentHealth(input as Parameters<typeof buildOmsFulfillmentHealth>[0]) as ReturnType<NonNullable<OmsManagedReadProjections["buildHealth"]>>,
  buildHealthDigests: input => buildOmsFulfillmentHealthDigests(input),
};
