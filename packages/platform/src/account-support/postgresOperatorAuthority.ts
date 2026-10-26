import type { NativeOperatorAuthorityPort } from "./contracts/index.js";
import { nativeSubscriptionCommand, leadAbsorption, recoveryResult, operatorRecoveryMaterial,
  type OperatorAuthorityOptions, CustomerSupportCommandRequiresHumanError, CustomerSupportOperatorInactiveError,
  CustomerSupportCommandInvalidError, CustomerSupportCommandIdempotencyConflictError, OperatorSubscriptionAuthorityUnavailableError } from "./operatorAuthority.js";

/** Narrow structural subset of a query executor; the host owns connection and transaction. */
export interface OperatorQueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface OperatorTransactionExecutor {
  run<T>(work: (executor: OperatorQueryExecutor) => Promise<T>): Promise<T>;
}
export const OPERATOR_AUTHORITY_UNAVAILABLE = {
  outcome: "refused", refusalCode: "operator_subscription_authority_unavailable",
} as const;
/** Native SQLSTATE mapping preserves the existing direct adapter's opaque fallback. */
function nativeCommandFailure(error: unknown, fallback: string): Error {
  const raw = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = typeof raw.message === "string" ? raw.message : "";
  if (message.includes("customer_support_command_requires_human")) return new CustomerSupportCommandRequiresHumanError();
  if (code === "42501" || message.includes("communications_operator_inactive")) return new CustomerSupportOperatorInactiveError();
  if (code === "22023" || /customer_support_(subscription_command|absorb_lead)_invalid/.test(message)) return new CustomerSupportCommandInvalidError();
  if (code === "23505" || message.includes("customer_support_idempotency_conflict")) return new CustomerSupportCommandIdempotencyConflictError();
  if (code === "42883" || /does not exist/i.test(message)) return new OperatorSubscriptionAuthorityUnavailableError();
  return new Error(fallback);
}
export function createPostgresOperatorAuthority(lane: OperatorTransactionExecutor, options: OperatorAuthorityOptions): NativeOperatorAuthorityPort {
  const operatorId = options.operatorId.trim();
  if (!operatorId) throw new Error("customer_support_operator_required");
  const check = (input: { operatorId: string }) => {
    if (input.operatorId !== operatorId) throw new Error("customer_support_operator_scope_mismatch");
  };
  const call = async (sql: string, values: unknown[], fallback: string): Promise<unknown> => {
    try {
      return await lane.run(async executor => {
        const { rows } = await executor.query(sql, values);
        if (rows.length !== 1 || !("result" in rows[0]!)) throw new Error("customer_support_routine_response_invalid");
        return rows[0]!.result;
      });
    } catch (error) {
      throw nativeCommandFailure(error, fallback);
    }
  };
  return {
    async applySubscriptionAction(input) {
      check(input);
      if (input.subscriptionAction === "change_shipping_address") return OPERATOR_AUTHORITY_UNAVAILABLE;
      const result = await call("SELECT public.customer_support_apply_subscription_action_v1($1,$2,$3,$4,$5,$6,$7) AS result", [
        operatorId, input.subscriptionId, input.subscriptionAction, input.payload ?? {}, input.expectedVersion,
        input.idempotencyKey, new Date(options.now()).toISOString(),
      ], "customer_support_subscription_command_failed");
      return nativeSubscriptionCommand(result);
    },
    async correctSubjectEmail(input) { check(input); return OPERATOR_AUTHORITY_UNAVAILABLE; },
    async correctSubjectPhone(input) { check(input); return OPERATOR_AUTHORITY_UNAVAILABLE; },
    async linkSubjectAccount(input) { check(input); return OPERATOR_AUTHORITY_UNAVAILABLE; },
    async absorbLead(input) {
      check(input);
      const result = await call("SELECT public.customer_support_absorb_lead_v1($1,$2,$3,$4,$5,$6) AS result", [
        operatorId, input.customerId, input.leadId, input.expectedLeadEmail, input.idempotencyKey, new Date(options.now()).toISOString(),
      ], "customer_support_lead_absorption_failed");
      return leadAbsorption(result);
    },
    async issueRecovery(input) {
      check(input);
      const material = await operatorRecoveryMaterial(input, options);
      // Preserve recovery's special conflict mapping and opaque non-conflict failure.
      let result: unknown;
      try {
        result = await lane.run(async executor => {
          const { rows } = await executor.query("SELECT public.customer_support_issue_recovery($1,$2,$3,$4,$5,$6,$7,$8) AS result", [
            operatorId, input.subjectId, input.caseId, input.idempotencyKey, material.payloadFingerprint,
            material.tokenHash, material.expiresAt, material.recoveryPath,
          ]);
          if (rows.length !== 1 || !("result" in rows[0]!)) throw new Error("customer_support_routine_response_invalid");
          return rows[0]!.result;
        });
      } catch (error) {
        const raw = (error ?? {}) as { code?: unknown; message?: unknown };
        if (typeof raw.message === "string" && raw.message.includes("customer_support_command_requires_human")) {
          throw new CustomerSupportCommandRequiresHumanError();
        }
        if (raw.code === "23505" || (typeof raw.message === "string" && raw.message.includes("idempotency_conflict"))) {
          return { outcome: "conflict", conflictCode: "idempotency_conflict" };
        }
        throw new Error("customer_support_recovery_failed");
      }
      return recoveryResult(result);
    },
  };
}
