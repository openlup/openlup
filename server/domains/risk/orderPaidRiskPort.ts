import { RISK_CONTRACT_VERSION, RISK_RULESET_VERSION } from "../../../src/domains/risk/types.js";
import type { RiskSubjectKind } from "../../../src/domains/risk/types.js";
import { evaluateRisk } from "../../../src/domains/risk/core/evaluator.js";
import type { RiskEvaluationInput } from "../../../src/domains/risk/core/types.js";
import type {
  RiskAssessmentWritePort,
  RiskCheckoutBlocklistPort,
} from "../../../src/domains/risk/ports.js";
import {
  deriveOrderMoney,
  type OrderMoneyHeaderRow,
} from "../../../src/domains/commerce/types.js";
import { riskSubjectHash } from "./riskFingerprint.js";

export type OrderPaidRiskResult =
  | { kind: "allow"; detail?: Record<string, unknown> }
  | { kind: "review" | "block"; detail?: Record<string, unknown> }
  | { kind: "retryable"; reason: string }
  | { kind: "fatal"; reason: string };

export interface OrderPaidRiskAssessmentPort {
  assessPaidOrder(input: {
    orderUuid: string;
    outboxEventId: string;
    signal: AbortSignal;
  }): Promise<OrderPaidRiskResult>;
}

export interface RiskOrderEvidence {
  id: string;
  clientId: string | null;
  subtotalCents: number | null;
  discountCents: number | null;
  shippingCents: number | null;
  shippingDiscountCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  currency: string | null;
  mode: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RiskPaymentIntentEvidence {
  id: string;
  amountCents: number;
  currency: string;
}

export interface RiskPaidOrderEvidencePort {
  readOrder(orderId: string): Promise<RiskOrderEvidence | null>;
  readSucceededPaymentIntent(
    orderId: string,
  ): Promise<RiskPaymentIntentEvidence | null>;
}

export function createOrderPaidRiskAssessmentPort({
  evidencePort,
  assessmentPort,
  blocklistPort,
  mode,
  hashSecret,
}: {
  evidencePort: RiskPaidOrderEvidencePort;
  assessmentPort: RiskAssessmentWritePort;
  blocklistPort: RiskCheckoutBlocklistPort;
  mode: "shadow" | "hold";
  hashSecret?: string | null;
}): OrderPaidRiskAssessmentPort {
  return {
    async assessPaidOrder({ orderUuid, outboxEventId, signal }) {
      if (signal.aborted) {
        return { kind: "retryable", reason: "risk_assessment_timeout" };
      }
      try {
        const order = await evidencePort.readOrder(orderUuid);
        if (!order) return { kind: "fatal", reason: "risk_order_not_found" };
        const intent = await evidencePort.readSucceededPaymentIntent(orderUuid);
        if (!intent) {
          return {
            kind: "retryable",
            reason: "risk_payment_intent_not_ready",
          };
        }
        const orderMoney = deriveOrderMoney(toOrderMoneyHeader(order));
        if (!orderMoney.reconciled) {
          throw new Error(
            `risk_order_money_invalid_input:${orderMoney.issueCodes.join(",")}`,
          );
        }

        const subjectRefs = buildSubjectRefs(order, hashSecret);
        const blocklist =
          subjectRefs.length > 0
            ? await blocklistPort.checkExactBlocklist({ subjectRefs })
            : { blocked: false, reasonCodes: [] };
        const evaluationInput: RiskEvaluationInput = {
          source: "paid_order",
          mode,
          checkout: {
            checkoutKind:
              order.mode === "subscription_cycle"
                ? "subscription_initial"
                : "one_time",
            totalMinor: orderMoney.total,
            currency: orderMoney.currency,
            promoCodeCount: promoCodeCount(order.metadata),
            bundleDiscountApplied: bundleDiscountApplied(order.metadata),
          },
          payment: {
            resultStatus: "succeeded",
            localAmountMinor: orderMoney.total,
            providerAmountMinor: intent.amountCents,
            localCurrency: orderMoney.currency,
            providerCurrency: intent.currency,
          },
          signals: {
            exactBlocklistMatches: blocklist.blocked
              ? [
                  {
                    subjectKind: "identity_cluster",
                    reasonCode: "exact_blocklist_match",
                  },
                ]
              : [],
            recentCheckoutAttemptsByIdentity: 0,
            distinctEmailsByIp24h: 0,
            discountedPaidOrders30d: 0,
            clientsSharingPaymentMethod7d: 0,
            priorDisputes: 0,
            highRiskCountries: [],
          },
        };
        const evaluated = evaluateRisk(evaluationInput);
        const persisted = await assessmentPort.assessPaidOrder({
          idempotencyKey: `risk:${outboxEventId}:${orderUuid}`,
          orderId: orderUuid,
          paymentIntentId: intent.id,
          paymentEventId: null,
          mode,
          occurredAt: new Date().toISOString(),
          subjectRefs,
          evidence: {
            sanitized: true,
            source: "commerce.order.paid",
            outboxEventId,
            blocklistReasonCodes: blocklist.reasonCodes,
          },
          evaluation: {
            contractVersion: RISK_CONTRACT_VERSION,
            rulesetVersion: RISK_RULESET_VERSION,
            ...evaluated,
          },
        });
        if (persisted.decision === "allow") {
          return {
            kind: "allow",
            detail: { assessmentId: persisted.assessmentId },
          };
        }
        return {
          kind: persisted.decision === "block" ? "block" : "review",
          detail: {
            assessmentId: persisted.assessmentId,
            caseId: persisted.caseId,
            holdId: persisted.holdId,
            holdOpened: persisted.holdOpened,
          },
        };
      } catch (error) {
        const message = safeError(error);
        if (
          /invalid_input|not_found|not_paid|idempotency_conflict|23505|22023/.test(
            message,
          )
        ) {
          return { kind: "fatal", reason: truncate(message) };
        }
        return { kind: "retryable", reason: truncate(message) };
      }
    },
  };
}

function toOrderMoneyHeader(order: RiskOrderEvidence): OrderMoneyHeaderRow {
  return {
    id: order.id,
    currency: requiredCurrency(order.currency),
    subtotal_cents: requiredMoneyMinor(order.subtotalCents),
    discount_cents: requiredMoneyMinor(order.discountCents),
    shipping_cents: requiredMoneyMinor(order.shippingCents),
    shipping_discount_cents: requiredMoneyMinor(order.shippingDiscountCents),
    tax_cents: requiredMoneyMinor(order.taxCents),
    total_cents: requiredMoneyMinor(order.totalCents),
  };
}

function requiredMoneyMinor(value: number | null): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new Error("risk_order_money_invalid_input");
  }
  return value as number;
}

function requiredCurrency(value: string | null): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("risk_order_money_invalid_input");
  }
  return value;
}

function buildSubjectRefs(
  order: RiskOrderEvidence,
  secret?: string | null,
): Array<{ subjectKind: RiskSubjectKind; subjectHash: string }> {
  const refs: Array<{
    subjectKind: RiskSubjectKind;
    subjectHash: string;
  }> = [];
  if (order.clientId) {
    refs.push({
      subjectKind: "client",
      subjectHash: riskSubjectHash("client", order.clientId, secret),
    });
  }
  refs.push({
    subjectKind: "identity_cluster",
    subjectHash: riskSubjectHash("order", order.id, secret),
  });
  return refs;
}

function promoCodeCount(metadata: Record<string, unknown> | null): number {
  return Array.isArray(metadata?.promoCodes) ? metadata.promoCodes.length : 0;
}

function bundleDiscountApplied(
  metadata: Record<string, unknown> | null,
): boolean {
  return metadata?.bundleDiscountApplied === true;
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return String(record.message ?? record.code ?? "risk_rpc_failed");
  }
  return String(error);
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}...` : value;
}
