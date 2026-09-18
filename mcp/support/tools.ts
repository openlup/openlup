import { z } from "zod";
import { customerDiagnosticsTool } from "./customerDiagnostics.js";
import { CLIENTS_PORTABLE_CONTRACT_VERSION } from "../../src/domains/clients/portableContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../src/domains/commerce/types.js";
import {
  SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
  customer360LookupRequestSchema,
} from "../../src/domains/support/customer360Contracts.js";
import { toolInputSchema, type McpToolDefinition } from "../_core/toolFromContract.js";
const OMS_BFF_BASE = "/api/bff/admin/commerce/orders";
const CLIENTS_BFF_BASE = "/api/bff/admin/clients";
const SUPPORT_BFF_BASE = "/api/bff/admin/support/customer-journey";
const supportSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  pageSize: z.coerce.number().int().min(1).max(10).default(5),
}).strict();

const supportOrderRequestSchema = z.object({
  orderId: z.string().uuid(),
}).strict();
export function buildSupportTools(): McpToolDefinition[] {
  return [
    customerDiagnosticsTool,
    {
      name: "support__search",
      description:
        "Search portable customer candidates and OMS orders in one read-only call. Use for email, phone, name, order number, order id, or subject id.",
      path: "mcp://support/search",
      contractVersion: null,
      requestSchema: supportSearchRequestSchema,
      inputSchema: toolInputSchema(supportSearchRequestSchema),
      call: async (input, { bffClient }) => {
        const query = String(input.query);
        const pageSize = Number(input.pageSize ?? 5);
        const [clients, orders] = await Promise.all([
          bffClient.get(
            `${CLIENTS_BFF_BASE}/search`,
            { query, page: 0, pageSize },
            { contractVersion: CLIENTS_PORTABLE_CONTRACT_VERSION },
          ),
          bffClient.get(
            OMS_BFF_BASE,
            { search: query, page: 1, pageSize },
            { contractVersion: COMMERCE_CONTRACT_VERSION },
          ),
        ]);
        return {
          query,
          customers: readArray(clients, "candidates").map(compactClientCandidate),
          orders: readArray(orders, "orders").map(compactOrderListItem),
          hints: {
            next: "Use support__order_snapshot for an orderId or support__customer_journey_snapshot with journeyLookup.subjectId.",
          },
        };
      },
    },
    {
      name: "support__customer_journey_search",
      description:
        "Find a portable customer-360 journey by neutral subject, order, subscription, or email lookup. Recovery remains available only on the mounted operator route. Read-only.",
      path: "mcp://support/customer-journey-search",
      contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
      requestSchema: customer360LookupRequestSchema,
      inputSchema: toolInputSchema(customer360LookupRequestSchema),
      call: async (input, { bffClient }) => {
        return bffClient.get(
          SUPPORT_BFF_BASE,
          { ...toJourneyQuery(input), mode: "search" },
          { contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION },
        );
      },
    },
    {
      name: "support__customer_journey_snapshot",
      description:
        "Return the portable customer-360 lifecycle, order, subscription, payment, dunning, recovery and audit snapshot. Recovery mutations stay on the mounted operator route. Read-only.",
      path: "mcp://support/customer-journey-snapshot",
      contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
      requestSchema: customer360LookupRequestSchema,
      inputSchema: toolInputSchema(customer360LookupRequestSchema),
      call: async (input, { bffClient }) => {
        return bffClient.get(
          SUPPORT_BFF_BASE,
          toJourneyQuery(input),
          { contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION },
        );
      },
    },
    {
      name: "support__order_snapshot",
      description:
        "Return a compact support snapshot for one order: customer, payment, fulfillment, holds, accounting, communications, and likely blockers.",
      path: "mcp://support/order-snapshot",
      contractVersion: null,
      requestSchema: supportOrderRequestSchema,
      inputSchema: toolInputSchema(supportOrderRequestSchema),
      call: async (input, { bffClient }) => {
        const detail = await bffClient.get(
          `${OMS_BFF_BASE}/detail`,
          { orderId: String(input.orderId) },
          { contractVersion: COMMERCE_CONTRACT_VERSION },
        );
        return buildOrderSnapshot(detail);
      },
    },
    {
      name: "support__explain_order_problem",
      description:
        "Explain deterministic support signals for one order: why it needs attention, what is blocked, and the safest next read-only checks.",
      path: "mcp://support/explain-order-problem",
      contractVersion: null,
      requestSchema: supportOrderRequestSchema,
      inputSchema: toolInputSchema(supportOrderRequestSchema),
      call: async (input, { bffClient }) => {
        const detail = await bffClient.get(
          `${OMS_BFF_BASE}/detail`,
          { orderId: String(input.orderId) },
          { contractVersion: COMMERCE_CONTRACT_VERSION },
        );
        const snapshot = buildOrderSnapshot(detail);
        return {
          ...snapshot,
          explanation: explainSnapshot(snapshot),
        };
      },
    },
  ];
}
function toJourneyQuery(input: Record<string, unknown>): Record<string, string | undefined> {
  const parsed = customer360LookupRequestSchema.parse(input);
  return {
    query: stringValue(parsed.query),
    subjectId: stringValue(parsed.subjectId),
    orderId: stringValue(parsed.orderId),
    subscriptionId: stringValue(parsed.subscriptionId),
    email: stringValue(parsed.email),
    pageSize: parsed.pageSize ? String(parsed.pageSize) : undefined,
  };
}

function buildOrderSnapshot(detailResponse: Record<string, unknown>): Record<string, unknown> {
  const order = readObject(detailResponse, "order");
  const customer = readObject(order, "customer");
  const payment = readObject(order, "payment");
  const fulfillment = readObject(order, "fulfillment");
  const fulfillmentEligibility = readObject(order, "fulfillmentEligibility");
  const accounting = readObject(order, "accounting");
  const actionEligibility = readObject(order, "actionEligibility");
  const holds = readArray(order, "holds");
  const communicationDeliveries = readArray(order, "communicationDeliveries");
  return {
    order: {
      orderId: readScalar(order, "orderId"),
      orderNumber: readScalar(order, "orderNumber"),
      status: readScalar(order, "status"),
      mode: readScalar(order, "mode"),
      attentionReason: readScalar(order, "attentionReason"),
      nextAction: readScalar(order, "nextAction"),
      createdAt: readScalar(order, "createdAt"),
      updatedAt: readScalar(order, "updatedAt"),
    },
    customer: {
      clientId: readScalar(customer, "id"),
      email: readScalar(customer, "email"),
      name: [readScalar(customer, "firstName"), readScalar(customer, "lastName")].filter(Boolean).join(" ") || null,
      phone: readScalar(customer, "phone"),
      lifecycleStage: readScalar(customer, "lifecycleStage"),
    },
    payment: {
      status: readScalar(payment, "status"),
      activeAttemptId: readScalar(payment, "activeAttemptId"),
      latestAttempt: compactLatest(readArray(order, "paymentAttempts"), ["id", "status", "nextActionKind", "updatedAt"]),
    },
    fulfillment: {
      status: readScalar(fulfillment, "status"),
      eligibility: fulfillmentEligibility,
      tracking: readArray(fulfillment, "trackingReferences").map((entry) =>
        pick(entry, ["trackingNumber", "carrierKind", "updatedAt"]),
      ),
    },
    accounting: pick(accounting, ["status", "ksefStatus", "outboxStatus", "recoveryGuidance"]),
    holds: holds.map((entry) => pick(entry, ["id", "status", "reason", "note", "createdAt", "releasedAt"])),
    communicationDeliveries: communicationDeliveries
      .slice(0, 5)
      .map((entry) => pick(entry, ["id", "channel", "templateKey", "status", "sentAt", "lastError"])),
    blockers: detectBlockers({ order, payment, fulfillmentEligibility, accounting, holds, actionEligibility }),
  };
}

function explainSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const blockers = readArray(snapshot, "blockers");
  return {
    primaryIssue: blockers[0] ?? "no_blocker_detected",
    blockerCount: blockers.length,
    recommendedReads: [
      "oms__get_order_detail",
      "clients__get_detail when customer.clientId is present",
      "support__search with customer email if identity is unclear",
    ],
    mutationPolicy: "This MCP support surface is read-only; do not resolve holds, edit addresses, dispatch fulfillment, or resend payment links through it.",
  };
}

function detectBlockers(input: {
  order: Record<string, unknown>;
  payment: Record<string, unknown>;
  fulfillmentEligibility: Record<string, unknown>;
  accounting: Record<string, unknown>;
  holds: Record<string, unknown>[];
  actionEligibility: Record<string, unknown>;
}): string[] {
  const blockers: string[] = [];
  if (input.holds.some((hold) => readScalar(hold, "status") === "active")) blockers.push("active_hold");
  const paymentStatus = readScalar(input.payment, "status");
  if (paymentStatus && paymentStatus !== "succeeded" && paymentStatus !== "paid") blockers.push(`payment_${paymentStatus}`);
  if (readScalar(input.fulfillmentEligibility, "allowed") === false) {
    blockers.push(`fulfillment_blocked_${readScalar(input.fulfillmentEligibility, "reason") ?? "unknown"}`);
  }
  const accountingStatus = readScalar(input.accounting, "status");
  if (accountingStatus && !["issued", "accepted", "not_requested"].includes(String(accountingStatus))) {
    blockers.push(`accounting_${accountingStatus}`);
  }
  const nextAction = readScalar(input.order, "nextAction");
  if (nextAction && nextAction !== "none") blockers.push(`next_action_${nextAction}`);
  return [...new Set(blockers)];
}

function compactClientCandidate(value: Record<string, unknown>): Record<string, unknown> {
  const subject = readObject(value, "subject");
  const journeyLookup = readObject(value, "journeyLookup");
  return {
    subject: pick(subject, [
      "subjectId",
      "displayName",
      "email",
      "phone",
      "lifecycleStage",
      "createdAt",
      "lastActivityAt",
    ]),
    matchedBy: readScalar(value, "matchedBy"),
    confidence: readScalar(value, "confidence"),
    journeyLookup: { subjectId: readScalar(journeyLookup, "subjectId") },
  };
}

function compactOrderListItem(value: Record<string, unknown>): Record<string, unknown> {
  const customer = readObject(value, "customer");
  return {
    ...pick(value, [
      "orderId",
      "orderNumber",
      "clientId",
      "status",
      "mode",
      "paymentStatus",
      "fulfillmentStatus",
      "inventoryStatus",
      "accountingStatus",
      "attentionReason",
      "nextAction",
      "activeHoldCount",
      "createdAt",
      "updatedAt",
    ]),
    customer: pick(customer, ["email", "firstName", "lastName", "phone", "lifecycleStage"]),
  };
}

function compactLatest(values: Record<string, unknown>[], keys: string[]): Record<string, unknown> | null {
  const [first] = values;
  return first ? pick(first, keys) : null;
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}

function readArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const raw = value[key];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  return isRecord(raw) ? raw : {};
}

function readScalar(value: Record<string, unknown>, key: string): string | number | boolean | null {
  const raw = value[key];
  return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
