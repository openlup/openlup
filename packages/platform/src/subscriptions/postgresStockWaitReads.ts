import { PAYMENT_INTENT_STATUSES } from "@openlup/core/payment";
import { z } from "zod";
import type { StockWaitAdminPage, StockWaitOperatorSummary, StockWaitReadNotice, StockWaitReadProjection, StockWaitReadState } from "./contracts/stockWaitReads.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { nativeStockWaitDeficits } from "./postgresStockWaitStore.js";
import { stockWaitNoticesSql, stockWaitPageSql, stockWaitSummarySql } from "./stockWaitReadQueries.js";

const state = z.enum(["waiting", "stock_secured", "resumed", "closed"]);
const filter = z.union([state, z.literal("all")]);
const id = z.guid();
const stamp = z.iso.datetime({ offset: true });
const nonnegative = z.int().nonnegative();
const pageInput = z.object({ state: filter, page: z.int().positive(), pageSize: z.int().min(1).max(100) });
const accountScope = z.object({ principalId: id, clientId: id, subscriptionIds: z.array(id) });
const coordinates = z.object({
  schemaVersion: z.literal(2), caseKind: z.enum(["legacy", "successor"]), id,
  carrierAvailable: z.literal(true),
  subscriptionId: id, clientId: id, state, cycleNumber: z.int().positive(), scheduledAt: stamp,
  orderId: id.nullable(), cycleId: id.nullable(), fulfillmentId: id.nullable(),
  openedAt: stamp, lastCheckedAt: stamp, stockSecuredAt: stamp.nullable(), resumedAt: stamp.nullable(), closedAt: stamp.nullable(),
  automaticRecoveryEligible: z.boolean(), independentBlock: z.string().nullable(), blockReason: z.string().nullable(),
  deficits: z.array(z.object({ sku: z.string().min(1), requiredUnits: z.int().positive(), reservedUnits: nonnegative,
    availableUnits: nonnegative, missingUnits: nonnegative }).passthrough()),
});
const managedDeficit = coordinates.shape.deficits.element.extend({
  skuId: id, productName: z.string().min(1), sizeG: z.number().nonnegative().nullable(),
});
const noticeSchema = z.object({
  id, kind: coordinates.shape.caseKind,
  templateSlug: z.enum(["subscription-stock-wait-started", "subscription-stock-wait-resumed"]),
  status: z.string().min(1), lastErrorCode: z.string().nullable(), updatedAt: stamp,
});
const summarySchema = z.object({
  totalCount: nonnegative,
  productTotals: z.array(z.object({ sku: z.string().min(1), displayName: z.string().min(1), missingUnits: nonnegative, affectedCases: nonnegative })),
});
const paymentSchema = z.enum(PAYMENT_INTENT_STATUSES);
const nativePayment = z.enum(["created", "settled", "failed", "cancelled"])
  .transform(status => status === "settled" ? "succeeded" : status);
const zero = (): StockWaitOperatorSummary => ({ totalCount: 0, productTotals: [] });

function caseRelationMissing(error: unknown) {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return (code === "42P01" || code === "PGRST205") && /\bpublic\.subscription_stock_wait_cases\b/.test(message ?? "");
}

function count(value: unknown) {
  return nonnegative.parse(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
}

/** Server-side operator, operational and owned account readers. Bind authority
 * to the authenticated request, and use one read-only repeatable-read snapshot
 * for each invocation. Selecting a reader does not mount a route.
 * @experimental
 */
export function createPostgresStockWaitReads(options: {
  graph: "native" | "managed";
  withReadSnapshot<T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  authorizeOperator(): Promise<boolean>;
  authorizeEvidence(): Promise<boolean>;
  /** Resolve the authenticated account and its exact subscription set server-side. */
  readOwnedAccount(): Promise<{ principalId: string; clientId: string; subscriptionIds: readonly string[] } | null>;
}) {
  const { graph, withReadSnapshot } = options;
  async function requireOperator() {
    if (await options.authorizeOperator() !== true) throw new Error("stock_wait_operator_forbidden");
  }
  async function selectCases(db: SubscriptionQueryExecutor, sql: string, values?: unknown[]) {
    try {
      const result = (await db.query(sql, values)).rows[0];
      if (!result) throw new Error("stock_wait_read_response_invalid");
      return result;
    } catch (error) {
      if (graph === "managed" && caseRelationMissing(error)) return null;
      throw error;
    }
  }

  async function project(db: SubscriptionQueryExecutor, value: unknown, openOnly: boolean): Promise<StockWaitReadProjection[]> {
    const rows = z.array(coordinates).parse(value)
      .filter(row => !openOnly || row.state === "stock_secured" || row.automaticRecoveryEligible);
    if (!rows.length) return [];
    const notices = new Map<string, StockWaitReadNotice[]>();
    const requests = rows.map(({ id, caseKind }) => ({ id, kind: caseKind }));
    for (const value of (await db.query(stockWaitNoticesSql(graph), [JSON.stringify(requests)])).rows) {
      const { id, kind, ...notice } = noticeSchema.parse(value);
      const key = `${kind}:${id}`;
      const group = notices.get(key) ?? [];
      group.push(notice);
      notices.set(key, group);
    }
    const nativeLines = graph === "native" ? await nativeStockWaitDeficits(db, rows.flatMap(row => row.deficits)) : [];
    let start = 0;
    return rows.map(({ carrierAvailable: _carrierAvailable, deficits, ...row }) => {
      const end = start + deficits.length;
      const lines = graph === "native" ? nativeLines.slice(start, end) : deficits.map(raw => {
        const line = managedDeficit.parse(raw);
        return { skuId: line.skuId, sku: line.sku, displayName: line.productName,
          size: line.sizeG === null ? null : `${line.sizeG} g`,
          required: line.requiredUnits, reserved: line.reservedUnits, available: line.availableUnits, missing: line.missingUnits };
      });
      start = end;
      return { ...row, deficits: lines, notices: notices.get(`${row.caseKind}:${row.id}`) ?? [] };
    });
  }

  async function payments(db: SubscriptionQueryExecutor, cases: StockWaitReadProjection[]) {
    const orderIds = [...new Set(cases.flatMap(row => row.orderId ? [row.orderId] : []))];
    const statuses = new Map<string, z.infer<typeof paymentSchema>>();
    if (!orderIds.length) return statuses;
    const sql = graph === "native" ? `SELECT i.order_id,i.status FROM public.commerce_settlement_intents i
      LEFT JOIN public.subscription_successor_operations_v2 g ON g.order_id=i.order_id
      WHERE i.order_id=ANY($1::uuid[]) AND (g.id IS NULL OR g.settlement_intent_id=i.id)` :
      "SELECT order_id,status FROM public.commerce_payment_intents WHERE order_id=ANY($1::uuid[])";
    for (const row of (await db.query(sql, [orderIds])).rows) {
      const persisted = graph === "native" ? nativePayment.safeParse(row.status) : paymentSchema.safeParse(row.status);
      if (!persisted.success) throw new Error("stock_wait_admin_payment_status_invalid");
      statuses.set(id.parse(row.order_id), persisted.data);
    }
    return statuses;
  }

  async function summary(db: SubscriptionQueryExecutor, state: StockWaitReadState | "all"): Promise<StockWaitOperatorSummary> {
    const result = await selectCases(db, stockWaitSummarySql(graph), [state]);
    if (!result) return zero();
    if (result.incomplete !== false) throw new Error("stock_wait_summary_evidence_invalid");
    return summarySchema.parse({ ...result, totalCount: count(result.totalCount) });
  }

  return {
    async readOperatorSummary(input: StockWaitReadState | "all"): Promise<StockWaitOperatorSummary> {
      await requireOperator();
      return withReadSnapshot(db => summary(db, filter.parse(input)));
    },
    async listAdmin(input: { state: StockWaitReadState | "all"; page: number; pageSize: number }): Promise<StockWaitAdminPage> {
      await requireOperator();
      const { state, page, pageSize } = pageInput.parse(input);
      const offset = nonnegative.parse((page - 1) * pageSize);
      return withReadSnapshot(async db => {
        const result = await selectCases(db, stockWaitPageSql(graph, "admin"), [state, pageSize, offset]);
        const totalCount = result ? count(result.totalCount) : 0;
        if (!result || !totalCount) return { ...zero(), cases: [], page, pageSize };
        const projected = await project(db, result.cases, false);
        const payment = await payments(db, projected);
        const cases: StockWaitAdminPage["cases"] = projected.map(row => {
          const status = row.orderId === null ? undefined : payment.get(row.orderId);
          return { ...row, paymentStatus: status ?? "not_started",
            paymentEvidence: status ? "recorded" : row.orderId === null ? "not_applicable" : "missing" };
        });
        const complete = await summary(db, state);
        if (complete.totalCount !== totalCount) throw new Error("stock_wait_summary_count_mismatch");
        return { ...complete, cases, page, pageSize };
      });
    },
    async listEvidence(): Promise<StockWaitReadProjection[]> {
      if (await options.authorizeEvidence() !== true) throw new Error("stock_wait_evidence_forbidden");
      return withReadSnapshot(async db => {
        const result = await selectCases(db, stockWaitPageSql(graph, "evidence"));
        return result ? project(db, result.cases, true) : [];
      });
    },
    async listCustomer(): Promise<StockWaitReadProjection[]> {
      const scope = await options.readOwnedAccount();
      if (!scope) throw new Error("stock_wait_customer_forbidden");
      const { principalId, clientId, subscriptionIds } = accountScope.parse(scope);
      if (!subscriptionIds.length) return [];
      return withReadSnapshot(async db => {
        const result = await selectCases(db, stockWaitPageSql(graph, "customer"), [clientId, principalId, subscriptionIds]);
        if (!result) return [];
        if (result.allowed !== true) throw new Error("stock_wait_customer_forbidden");
        return project(db, result.cases, true);
      });
    },
  };
}

/** Healthy wait evidence requires a current shortage, a recent check and
 * confirmed or fresh notice evidence. The clock is inclusive at 30 minutes.
 * @experimental
 */
export function stockWaitHealth(rows: readonly StockWaitReadProjection[], now: Date) {
  function fresh(value: string) {
    const age = now.getTime() - Date.parse(value);
    return age >= 0 && age <= 30 * 60 * 1000;
  }
  const evidence = rows.map(row => {
    const notice = row.notices.find(item => item.templateSlug === "subscription-stock-wait-started");
    const noticeHealthy = !!notice && (["sent", "delivered"].includes(notice.status) ||
      (["planned", "queued", "processing"].includes(notice.status) && fresh(notice.updatedAt)));
    return { subscriptionId: row.subscriptionId, scheduledAt: row.scheduledAt,
      healthy: row.state === "waiting" && row.deficits.some(line => line.missing > 0) &&
        !row.blockReason && !row.independentBlock && fresh(row.lastCheckedAt) && noticeHealthy };
  });
  const stalledCount = rows.filter((row, index) => row.state === "waiting" && !evidence[index]!.healthy ||
    row.state === "stock_secured" && !!row.blockReason).length;
  return { evidence, stalledCount };
}
