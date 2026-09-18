import type {
  OmnipackDispatchCandidate,
  OmnipackDispatchAcceptanceResult,
  OmnipackDispatchPort,
  OmnipackDispatchReadBack,
  OmnipackDispatchRefResult,
  OmnipackDispatchRefStatus,
  OmnipackDispatchSubmissionResult,
} from "../../domains/fulfillment/omnipackDispatchWorker.js";
import { OMNIPACK_DISPATCH_CONTACT_STALE } from "../../domains/fulfillment/omnipackDispatchContracts.js";
import { parseOmnipackDispatchAcceptanceResult } from "../../domains/fulfillment/omnipackDispatchAcceptance.js";
import {
  OMNIPACK_DISPATCH_CANDIDATE_SELECT,
  type OmnipackDispatchCandidateRow,
  nullableText,
  omnipackDispatchCandidateIds,
  text,
  toOmnipackDispatchCandidate,
  toOmnipackDispatchReadBack,
  toOmnipackDispatchReadBackFromRpc,
} from "./omnipackDispatchMappers.js";

export interface OmnipackDispatchSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  limit(count: number): PromiseLike<SupabaseQueryResult>;
  maybeSingle(): PromiseLike<SupabaseQueryResult>;
}

interface SupabaseQueryResult {
  data: unknown;
  error: RpcError | null;
}

interface RpcError {
  code?: string;
  message?: string;
}

export function createSupabaseOmnipackDispatchPort(client: OmnipackDispatchSupabaseClient): OmnipackDispatchPort {
  return {
    async listCandidates(limit: number): Promise<OmnipackDispatchCandidate[]> {
      const candidateIdsResult = await client.rpc("omnipack_dispatch_candidate_ids", { p_limit: limit });
      if (candidateIdsResult.error) {
        throw new Error(`omnipack_dispatch_candidates_read_failed:${candidateIdsResult.error.code ?? "unknown"}`);
      }
      const candidateIds = omnipackDispatchCandidateIds(candidateIdsResult.data);
      if (candidateIds.length === 0) return [];

      const result = await client
        .from("commerce_fulfillment_orders")
        .select(OMNIPACK_DISPATCH_CANDIDATE_SELECT)
        .in("id", candidateIds)
        .order("created_at", { ascending: true })
        .limit(candidateIds.length);
      if (result.error) throw new Error(`omnipack_dispatch_candidates_read_failed:${result.error.code ?? "unknown"}`);

      const rows = (Array.isArray(result.data) ? result.data : []) as OmnipackDispatchCandidateRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return candidateIds
        .map((id) => byId.get(id))
        .filter((row): row is OmnipackDispatchCandidateRow => Boolean(row))
        .map(toOmnipackDispatchCandidate);
    },

    async readCandidateByFulfillmentOrderId(fulfillmentOrderId): Promise<OmnipackDispatchCandidate | null> {
      const result = await client
        .from("commerce_fulfillment_orders")
        .select(OMNIPACK_DISPATCH_CANDIDATE_SELECT)
        .eq("id", fulfillmentOrderId)
        .in("status", [
          "created",
          "label_pending",
          "label_created",
          "packed",
          "handed_over",
          "in_transit",
          "delivered",
        ])
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_dispatch_candidate_read_failed:${result.error.code ?? "unknown"}`);
      return result.data ? toOmnipackDispatchCandidate(result.data as OmnipackDispatchCandidateRow) : null;
    },

    async prepareDispatchContact(fulfillmentOrderId) {
      const { data, error } = await client.rpc("omnipack_prepare_dispatch_contact_v1", {
        p_fulfillment_order_id: fulfillmentOrderId,
      });
      if (error) throw new Error(`omnipack_dispatch_contact_prepare_failed:${error.code ?? "unknown"}`);
      const row = data as Record<string, unknown> | null;
      const disposition = row?.disposition;
      const deliveryContactRevision = row?.deliveryContactRevision;
      if (
        disposition === "ready"
        && typeof deliveryContactRevision === "number"
        && Number.isInteger(deliveryContactRevision)
        && deliveryContactRevision > 0
      ) {
        return { disposition, deliveryContactRevision };
      }
      if (disposition === "withheld" && deliveryContactRevision === null) {
        return { disposition, deliveryContactRevision: null };
      }
      throw new Error("omnipack_dispatch_contact_prepare_readback_invalid");
    },

    async markStaleSubmissionsUncertain(staleBefore): Promise<number> {
      const { data, error } = await client.rpc("omnipack_mark_stale_dispatch_submissions_uncertain", {
        p_stale_before: staleBefore,
      });
      if (error) throw new Error(`omnipack_dispatch_stale_submission_write_failed:${error.code ?? "unknown"}`);
      const row = data as Record<string, unknown> | null;
      return typeof data === "number" ? data : Number(row?.markedUncertain ?? row?.updatedCount ?? 0);
    },

    async recordProviderAttempt(input): Promise<{ replayed: boolean }> {
      const { data, error } = await client.rpc("commerce_fulfillment_record_provider_attempt", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_provider_kind: "omnipack",
        p_status: input.status,
        p_request_payload: input.requestPayload,
        p_response_payload: input.responsePayload,
        p_error: input.error,
        p_actor_user_id: null,
        p_metadata: input.metadata,
      });
      if (error) throw new Error(`omnipack_provider_attempt_write_failed:${error.code ?? "unknown"}`);
      return { replayed: Boolean((data as { replayed?: boolean } | null)?.replayed) };
    },

    async recordDispatchRef(input): Promise<OmnipackDispatchRefResult> {
      const { data, error } = await client.rpc("omnipack_record_dispatch_ref_v2", {
        p_idempotency_key: input.idempotencyKey,
        p_fulfillment_order_id: input.fulfillmentOrderId,
        p_provider_order_id: input.providerOrderId,
        p_dispatch_mode: input.dispatchMode,
        p_status: input.status,
        p_request_fingerprint: input.requestFingerprint,
        p_sanitized_request: input.sanitizedRequest,
        p_sanitized_response: input.sanitizedResponse,
        p_error: input.error,
      });
      if (error) throw dispatchRpcError("omnipack_dispatch_ref_write_failed", error);
      const row = data as Record<string, unknown>;
      if (row.retryableReason === OMNIPACK_DISPATCH_CONTACT_STALE) {
        throw new Error(OMNIPACK_DISPATCH_CONTACT_STALE);
      }
      return {
        dispatchRefId: text(row.dispatchRefId),
        fulfillmentOrderId: text(row.fulfillmentOrderId),
        orderId: text(row.orderId),
        providerOrderId: nullableText(row.providerOrderId),
        status: text(row.status) as OmnipackDispatchRefStatus,
        replayed: row.replayed === true,
      };
    },

    async readDispatchRefByIdempotencyKey(idempotencyKey): Promise<OmnipackDispatchReadBack | null> {
      const result = await client
        .from("omnipack_dispatch_refs")
        .select("id, fulfillment_order_id, order_id, provider_order_id, dispatch_mode, status, request_idempotency_key, sanitized_request")
        .eq("request_idempotency_key", idempotencyKey)
        .maybeSingle();
      if (result.error) throw new Error(`omnipack_dispatch_ref_readback_failed:${result.error.code ?? "unknown"}`);
      return result.data ? toOmnipackDispatchReadBack(result.data as Record<string, unknown>) : null;
    },

    async beginSubmission(input): Promise<OmnipackDispatchSubmissionResult> {
      const { data, error } = await client.rpc("omnipack_begin_direct_dispatch_submission", {
        p_dispatch_ref_id: input.dispatchRefId,
        p_request_fingerprint: input.requestFingerprint,
      });
      if (error) throw dispatchRpcError("omnipack_dispatch_submission_begin_failed", error);
      const row = data as Record<string, unknown>;
      if (row.retryableReason === OMNIPACK_DISPATCH_CONTACT_STALE) {
        throw new Error(OMNIPACK_DISPATCH_CONTACT_STALE);
      }
      return {
        ...toOmnipackDispatchReadBackFromRpc(row),
        begun: row.begun === true,
        replayed: row.replayed === true,
      };
    },

    async acknowledgeDispatchAcceptance(input): Promise<OmnipackDispatchAcceptanceResult> {
      const { data, error } = await client.rpc("omnipack_acknowledge_dispatch_acceptance", {
        p_dispatch_ref_id: input.dispatchRefId,
        p_provider_order_id: input.providerOrderId,
        p_provider_attempt_idempotency_key: input.providerAttemptIdempotencyKey,
        p_label_idempotency_key: input.labelIdempotencyKey,
        p_sanitized_request: input.sanitizedRequest,
        p_sanitized_response: input.sanitizedResponse,
        p_metadata: input.metadata,
      });
      if (error) throw new Error(`omnipack_dispatch_acceptance_write_failed:${error.code ?? "unknown"}`);
      return parseOmnipackDispatchAcceptanceResult(
        data,
        "omnipack_dispatch_acceptance_readback_invalid",
      );
    },

    async finalizeSubmission(input): Promise<OmnipackDispatchReadBack> {
      const explicitProviderOrderId = input.providerOrderId?.trim() || null;
      const responseProviderOrderId = input.sanitizedResponse.providerOrderId;
      if (
        responseProviderOrderId !== undefined
        && (
          typeof responseProviderOrderId !== "string"
          || responseProviderOrderId.trim().length === 0
          || (explicitProviderOrderId !== null && responseProviderOrderId.trim() !== explicitProviderOrderId)
        )
      ) {
        throw new Error("omnipack_dispatch_submission_provider_order_mismatch");
      }
      const sanitizedResponse = explicitProviderOrderId && responseProviderOrderId === undefined
        ? { ...input.sanitizedResponse, providerOrderId: explicitProviderOrderId }
        : input.sanitizedResponse;
      const { data, error } = await client.rpc("omnipack_finalize_dispatch_submission", {
        p_dispatch_ref_id: input.dispatchRefId,
        p_may_have_succeeded: input.mayHaveSucceeded,
        p_sanitized_response: sanitizedResponse,
        p_error: input.error,
      });
      if (error) throw new Error(`omnipack_dispatch_submission_finalize_failed:${error.code ?? "unknown"}`);
      return toOmnipackDispatchReadBackFromRpc((data ?? {}) as Record<string, unknown>);
    },
  };
}

function dispatchRpcError(prefix: string, error: RpcError): Error {
  if (error.message?.includes(OMNIPACK_DISPATCH_CONTACT_STALE)) {
    return new Error(OMNIPACK_DISPATCH_CONTACT_STALE);
  }
  return new Error(`${prefix}:${error.code ?? "unknown"}`);
}
