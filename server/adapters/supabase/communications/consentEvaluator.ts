// Node consent-evaluator port for marketing dispatch. It carried the
// evaluateEmailPolicy contract for the api/ side, which could not import the
// Deno copy; that copy went with the Edge tree on 2026-09-04. It wraps the
// `communication_evaluate_email_policy` RPC.
//
// FAIL CLOSED: this port is the ONLY consent gate on the api/ side, so a marketing
// send must never proceed without an authoritative allow/deny decision. Every
// non-decision (RPC transport error, thrown client, or a 200 with an unintelligible
// shape) throws ConsentEvaluationUnavailableError instead of fabricating an "allow".
// The outbox dispatch worker catches the throw and maps it to a retry
// (outboxDispatchWorker.ts: `catch (error) => { kind: "retry" }`), so a transient
// policy outage recovers on the next attempt and a persistent one DLQs + alerts —
// it never floods opt-outs. Only an explicitly parsed `allowed:false` is honored as
// a quiet skip (no retry). Previously this failed OPEN, which during a policy-RPC
// outage would have sent marketing to suppressed/opted-out recipients — exactly the
// failure class behind the 2026-06-21 email-flood incident.

import {
  ConsentEvaluationUnavailableError,
  type ConsentEvaluation,
  type ConsentEvaluationInput,
  type ConsentEvaluatorPort,
} from "../../../domains/commerce/marketingEmailPorts.js";

export interface ConsentEvaluatorClient {
  rpc(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readEvaluation(value: unknown): ConsentEvaluation | null {
  if (!isRecord(value)) return null;
  return {
    allowed: value.allowed === true,
    reason: typeof value.reason === "string" ? value.reason : "unknown",
    decisionId: typeof value.decisionId === "string" ? value.decisionId : null,
  };
}

export function createSupabaseConsentEvaluator(
  client: ConsentEvaluatorClient,
): ConsentEvaluatorPort {
  return {
    async evaluate(input: ConsentEvaluationInput): Promise<ConsentEvaluation> {
      let data: unknown;
      let error: { message?: string } | null;
      try {
        ({ data, error } = await client.rpc("communication_evaluate_email_policy", {
          p_email: input.email,
          p_purpose: input.purpose,
          p_source: "marketing_cron",
          p_recipient_kind: input.recipientKind ?? "customer",
          p_source_table: input.sourceTable ?? null,
          p_source_id: input.sourceId ?? null,
          p_metadata: {},
        }));
      } catch (err) {
        // Transport/client exception: no authoritative decision. Fail closed
        // (retryable) — never fabricate an allow.
        const detail = err instanceof Error ? err.message : String(err);
        console.warn("[marketing-consent] evaluate threw; failing closed:", detail);
        throw new ConsentEvaluationUnavailableError(`policy_rpc_threw: ${detail}`);
      }

      if (error) {
        console.warn(
          "[marketing-consent] evaluate failed; failing closed:",
          error.message ?? error,
        );
        throw new ConsentEvaluationUnavailableError(
          `policy_rpc_error: ${error.message ?? "unknown"}`,
        );
      }

      const evaluation = readEvaluation(data);
      if (evaluation === null) {
        // 200 but the shape is unintelligible — a contract drift, not a decision.
        // Fail closed (retryable) so it surfaces (DLQ/alert) instead of silently
        // sending or silently dropping.
        console.warn("[marketing-consent] evaluate returned unparseable shape; failing closed");
        throw new ConsentEvaluationUnavailableError("policy_response_unparseable");
      }
      return evaluation;
    },
  };
}
