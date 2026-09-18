import { ORDER_HEADER_MONEY_COLUMNS } from "../../../src/domains/commerce/types.js";
import type {
  RiskAssessmentWritePort,
  RiskCheckoutBlocklistPort,
} from "../../../src/domains/risk/ports.js";
import {
  createOrderPaidRiskAssessmentPort,
  type OrderPaidRiskAssessmentPort,
  type RiskOrderEvidence,
  type RiskPaidOrderEvidencePort,
  type RiskPaymentIntentEvidence,
} from "../../domains/risk/orderPaidRiskPort.js";

interface SupabaseSelectBuilder {
  select(columns: string): SupabaseSelectBuilder;
  eq(column: string, value: unknown): SupabaseSelectBuilder;
  order(
    column: string,
    options: { ascending: boolean },
  ): SupabaseSelectBuilder;
  limit(count: number): SupabaseSelectBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown | null }>;
}

export interface RiskSupabaseClient {
  from(table: string): SupabaseSelectBuilder;
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown | null }>;
}

type RiskOrderRow = {
  id: string;
  client_id: string | null;
  subtotal_cents: number | null;
  discount_cents: number | null;
  shipping_cents: number | null;
  shipping_discount_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  currency: string | null;
  mode: string | null;
  metadata: Record<string, unknown> | null;
};

type RiskPaymentIntentRow = {
  id: string;
  amount_cents: number;
  currency: string;
};

export function createSupabaseOrderPaidRiskAssessmentPort({
  client,
  mode,
  hashSecret,
}: {
  client: RiskSupabaseClient;
  mode: "shadow" | "hold";
  hashSecret?: string | null;
}): OrderPaidRiskAssessmentPort {
  return createOrderPaidRiskAssessmentPort({
    evidencePort: createSupabaseRiskPaidOrderEvidencePort(client),
    assessmentPort: createSupabaseRiskAssessmentPort(client),
    blocklistPort: createSupabaseRiskCheckoutBlocklistPort(client),
    mode,
    hashSecret,
  });
}

export function createSupabaseRiskCheckoutBlocklistPort(
  client: RiskSupabaseClient,
): RiskCheckoutBlocklistPort {
  return {
    async checkExactBlocklist(input) {
      const { data, error } = await client.rpc("risk_check_exact_blocklist", {
        p_subject_refs: input.subjectRefs.map((ref) => ({
          subjectKind: ref.subjectKind,
          subjectHash: ref.subjectHash,
        })),
      });
      if (error) throw error;
      const record = readRecord(data);
      return {
        blocked: record.blocked === true,
        reasonCodes: Array.isArray(record.reasonCodes)
          ? record.reasonCodes.filter(
              (code): code is string => typeof code === "string",
            )
          : [],
      };
    },
  };
}

export function createSupabaseRiskAssessmentPort(
  client: RiskSupabaseClient,
): RiskAssessmentWritePort {
  return {
    async assessPaidOrder(request) {
      const { data, error } = await client.rpc("risk_assess_paid_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_payment_intent_id: request.paymentIntentId,
        p_payment_event_id: request.paymentEventId,
        p_mode: request.mode,
        p_evaluation: request.evaluation,
        p_subject_refs: request.subjectRefs,
        p_evidence: request.evidence,
        p_occurred_at: request.occurredAt,
      });
      if (error) throw error;
      const record = readRecord(data);
      return {
        assessmentId: readString(record.assessmentId),
        caseId: readNullableString(record.caseId),
        holdId: readNullableString(record.holdId),
        decision: readString(record.decision) as
          | "allow"
          | "manual_review"
          | "block",
        holdOpened: record.holdOpened === true,
        replayed: record.replayed === true,
      };
    },
  };
}

export function createSupabaseRiskPaidOrderEvidencePort(
  client: RiskSupabaseClient,
): RiskPaidOrderEvidencePort {
  return {
    async readOrder(orderId): Promise<RiskOrderEvidence | null> {
      const { data, error } = await client
        .from("commerce_orders")
        .select(`id,client_id,mode,metadata,${ORDER_HEADER_MONEY_COLUMNS}`)
        .eq("id", orderId)
        .maybeSingle();
      if (error) throw error;
      if (!data || typeof data !== "object") return null;
      const row = data as RiskOrderRow;
      return {
        id: row.id,
        clientId: row.client_id,
        subtotalCents: row.subtotal_cents,
        discountCents: row.discount_cents,
        shippingCents: row.shipping_cents,
        shippingDiscountCents: row.shipping_discount_cents,
        taxCents: row.tax_cents,
        totalCents: row.total_cents,
        currency: row.currency,
        mode: row.mode,
        metadata: row.metadata,
      };
    },
    async readSucceededPaymentIntent(
      orderId,
    ): Promise<RiskPaymentIntentEvidence | null> {
      const { data, error } = await client
        .from("commerce_payment_intents")
        .select("id,amount_cents,currency")
        .eq("order_id", orderId)
        .eq("status", "succeeded")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data || typeof data !== "object") return null;
      const row = data as RiskPaymentIntentRow;
      return { id: row.id, amountCents: row.amount_cents, currency: row.currency };
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid risk RPC response");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Invalid risk RPC response");
  }
  return value;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
