import type { PostgresDataGatewayEnv, PostgresDataGatewayOptions } from "../data/index.js";
import { evaluateCommunicationPolicy } from "./consentPolicy.js";
import { defaultCommunicationPurposeRegistry } from "./consentPurposeRegistry.js";
import type { CommunicationPurposeRegistry } from "./contracts/consent.js";
import type { CommunicationPermissionState } from "./contracts/types.js";
import { NativeConsentEvaluationUnavailableError, type NativeConsentDecision, type NativeConsentInput } from "./nativeOperations.js";
import { nativeEmail, nativeFingerprint, nativeText, nativeTransactions } from "./postgresNativeOperations.js";
export interface NativeConsentOptions extends PostgresDataGatewayOptions {
  registry?: CommunicationPurposeRegistry<string>;
  /** Host-owned authoritative tester pause, read in the decision transaction. Missing means unpaused. */
  testerPaused?: (db: import("../data/index.js").PgQueryExecutor, input: NativeConsentInput) => Promise<boolean>;
}
export interface NativeConsentEvaluator {
  evaluate(input: NativeConsentInput): Promise<NativeConsentDecision>;
  close(): Promise<void>;
  readonly guarantees: { readonly managedFrequencyCaps: false; readonly legacyContactTouching: false; readonly sendTimeFence: false };
}
/** Bounded P4 policy, authoritative native permission and durable decision. Evaluation never sends. */
export function createPostgresConsentEvaluator(env: PostgresDataGatewayEnv, options: NativeConsentOptions = {}): NativeConsentEvaluator {
  const lane = nativeTransactions(env, options, ["public.communication_native_policy_decisions","public.communication_recipient_consents","public.notification_recipients"]);
  const registry = options.registry ?? defaultCommunicationPurposeRegistry;
  return {
    close: lane.close,
    guarantees: { managedFrequencyCaps: false, legacyContactTouching: false, sendTimeFence: false },
    async evaluate(input) {
      try {
        const email = nativeEmail(input.email), fingerprint = nativeFingerprint(email), purpose = nativeText(input.purpose);
        const recipientKind = input.recipientKind ?? "external_contact";
        if (!["external_contact","tester","customer","lead","admin_internal"].includes(recipientKind)) throw new Error("native_recipient_kind_invalid");
        return await lane.run(async db => {
          const permission = (await db.query("SELECT state,captured_at,updated_at FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 AND purpose=$2 FOR SHARE", [fingerprint,purpose])).rows[0];
          if (permission && !["granted","denied","suppressed"].includes(String(permission.state))) throw new Error("native_permission_invalid");
          const paused = purpose === "tester_program" && options.testerPaused ? await options.testerPaused(db,input) : false;
          if (typeof paused !== "boolean") throw new Error("native_pause_invalid");
          let result = evaluateCommunicationPolicy({ purpose,recipientKind,permission: { state: permission ? permission.state as CommunicationPermissionState : null,legacySequencePaused: paused } }, registry);
          let activeRecipient: boolean | null = null;
          if (purpose === "admin_notification") {
            const rows = (await db.query("SELECT active FROM public.notification_recipients WHERE id=$1 AND email=$2 FOR SHARE", [input.sourceTable === "notification_recipients" ? input.sourceId ?? null : null,email])).rows;
            activeRecipient = rows.length === 1 && rows[0].active === true;
            if (!activeRecipient) result = { decision: "blocked",reason: "notification_recipient_inactive" };
          }
          const row = (await db.query(`INSERT INTO public.communication_native_policy_decisions (recipient_fingerprint,purpose,allowed,reason,permission_snapshot,source_table,source_id)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`, [fingerprint,purpose,result.decision === "allowed",result.reason,JSON.stringify({ permission: permission ?? null,legacySequencePaused: paused,activeRecipient,recipientKind }),input.sourceTable ?? null,input.sourceId ?? null])).rows[0];
          return { allowed: result.decision === "allowed",reason: result.reason,decisionId: nativeText(row?.id) };
        });
      } catch (error) { throw new NativeConsentEvaluationUnavailableError(error); }
    },
  };
}
