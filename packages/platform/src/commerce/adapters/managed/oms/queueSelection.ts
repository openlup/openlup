import type { OmsManagedReadProjections } from "../../../contracts/omsTypes.js";
type MatchSchema = NonNullable<OmsManagedReadProjections["queueMatchSchema"]>;
import type { QueueSelection } from "../../../contracts/omsTypes.js";
import { neutralOmsCurrencyPolicy,type OmsCurrencyPolicy } from "../../../model/omsCurrency.js";
import type {
AdminCommerceOrdersListRequest,
AdminOmsOrderListSummaryCounts,
AdminOmsOrderSearchMatch
} from "../../../oms/omsContracts.js";
import { omsOrderListSummaryCountsSchema,omsOrderListSummaryTotalsSchema,omsOrderSearchMatchSchema } from "../../../oms/omsContracts.js";
import { CommerceOmsPersistenceError } from "../../../oms/omsPorts.js";
import type { CommerceOmsStore,RpcError } from "./types.js";
export type { QueueSelection } from "../../../contracts/omsTypes.js";

/** The refusal the queue RPC raises when the paid set spans several currencies. */
const MIXED_CURRENCY_REFUSAL = "commerce_oms_summary_mixed_currency";

export async function readQueueSelection(
  client: CommerceOmsStore,
  request: AdminCommerceOrdersListRequest,
  options: { currency?: OmsCurrencyPolicy; matchSchema?: MatchSchema; projectResult?(data: unknown): unknown } = {},
): Promise<QueueSelection> {
  const { data, error } = await client.rpc("commerce_oms_admin_list_queue", {
    p_page: request.page,
    p_page_size: request.pageSize,
    p_search: request.search ?? null,
    p_status: request.status ?? null,
    p_mode: request.mode ?? null,
    p_payment_status: request.paymentStatus ?? null,
    p_fulfillment_status: request.fulfillmentStatus ?? null,
    p_inventory_status: request.inventoryStatus ?? null,
    p_accounting_status: request.accountingStatus ?? null,
    p_provider_ops_status: request.providerOpsStatus ?? null,
    p_attention_reason: request.attentionReason ?? null,
    p_attention_only: request.attentionOnly ?? false,
    p_next_action: request.nextAction ?? null,
    p_from: request.from ?? null,
    p_to: request.to ?? null,
    p_sort: request.sort,
    // Default false: the queue hides withdrawn rows unless the operator asks.
    // The RPC declares no parameter defaults, so this must always be sent.
    p_include_withdrawn: request.includeWithdrawn ?? false,
  });
  if (error) throw queueSelectionError(error);
  return parseQueueSelection(options.projectResult?.(data) ?? data, options.currency ?? neutralOmsCurrencyPolicy, options.matchSchema);
}

// A cross-currency paid set is a refusal the RPC raises on purpose, not a
// generic read failure: it names an operator-visible condition (two currencies
// in one dashboard total) that a retry will not clear. Keep it distinguishable.
function queueSelectionError(error: RpcError): CommerceOmsPersistenceError {
  const raised = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`;
  if (raised.includes(MIXED_CURRENCY_REFUSAL)) {
    return new CommerceOmsPersistenceError(
      "Commerce OMS queue summary spans more than one currency",
      { reason: MIXED_CURRENCY_REFUSAL },
    );
  }
  return new CommerceOmsPersistenceError("Commerce OMS queue selection read failed");
}

function parseQueueSelection(data: unknown, currency: OmsCurrencyPolicy, matchSchema: MatchSchema = omsOrderSearchMatchSchema): QueueSelection {
  const record = isRecord(data) ? data : {};
  const orderIds = Array.isArray(record.orderIds)
    ? record.orderIds.filter((id): id is string => typeof id === "string")
    : [];
  const totalCount = Number(record.totalCount ?? 0);
  const summaryCounts = omsOrderListSummaryCountsSchema.parse({
    ...ZERO_SUMMARY_COUNTS,
    ...(isRecord(record.summaryCounts) ? record.summaryCounts : {}),
  });
  const summaryTotals = omsOrderListSummaryTotalsSchema.parse({
    gmv: { amountMinor: 0, currency: currency.defaultCurrency },
    aov: { amountMinor: 0, currency: currency.defaultCurrency },
    orderCount: 0, paidSubscriptionCycleCount: 0,
    ...normalizeSummaryTotals(isRecord(record.summaryTotals) ? record.summaryTotals : {}, currency),
  });
  const matches = parseMatches(record.matches, matchSchema);
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new CommerceOmsPersistenceError("Commerce OMS queue selection count invalid");
  }
  return { orderIds, totalCount, matches, summaryCounts, summaryTotals };
}

function parseMatches(value: unknown, schema: MatchSchema): Record<string, AdminOmsOrderSearchMatch> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([orderId, match]) => {
      const parsed = schema.safeParse(match);
      return parsed.success ? [[orderId, parsed.data]] : [];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// The queue RPC still emits the legacy `newSubscriptionCount` JSON key. It counts
// PAID subscription cycles (the initial checkout cycle #1 plus every paid renewal),
// so map it onto the accurately-named `paidSubscriptionCycleCount` contract field.
// The new key is accepted too, so a future RPC rename is a no-op here.
function normalizeSummaryTotals(raw: Record<string, unknown>, currency: OmsCurrencyPolicy): Record<string, unknown> {
  const { newSubscriptionCount, gmv, aov, ...rest } = raw;
  const normalized: Record<string, unknown> = { ...rest };
  if (gmv !== undefined) normalized.gmv = withDefaultCurrency(gmv, currency);
  if (aov !== undefined) normalized.aov = withDefaultCurrency(aov, currency);
  if (newSubscriptionCount !== undefined) {
    normalized.paidSubscriptionCycleCount = normalized.paidSubscriptionCycleCount ?? newSubscriptionCount;
  }
  return normalized;
}

// The queue RPC no longer names a currency: `min(currency)` over an EMPTY paid
// set is NULL by design, so the schema stays currency-agnostic. Labelling a
// zero total is a platform-policy decision, and policy has exactly one home.
function withDefaultCurrency(money: unknown, currency: OmsCurrencyPolicy): unknown {
  if (!isRecord(money) || money.currency != null) return money;
  return { ...money, currency: currency.defaultCurrency };
}

const ZERO_SUMMARY_COUNTS: AdminOmsOrderListSummaryCounts = {
  needsAttention: 0,
  activeHold: 0,
  readyForFulfillment: 0,
  paymentIssues: 0,
  inventoryRisk: 0,
  fulfillmentBlocked: 0,
  fulfillmentExceptions: 0,
  invoiceIssues: 0,
  providerDispatchedNotPicked: 0,
};
