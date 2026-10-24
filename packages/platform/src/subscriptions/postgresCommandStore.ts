import type { SubscriptionCommand, SubscriptionCommandPort, SubscriptionCommandReceipt, SubscriptionCommandRefusal } from "./contracts/commands.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "./index.js";

export interface NativeSubscriptionCommand {
  actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
  action: string; payload: Record<string, unknown>; now: string;
}
export interface NativeSubscriptionCommandBinding {
  /** The callback must use one connection and commit/rollback the complete unit. */
  withTransaction<T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** Validate address ownership and refuse address mutation; resolve SKUs and
   * composition policy using trusted host evidence. No current-cycle write. */
  futureTerms(command: Extract<SubscriptionCommand, { action: "edit_future_terms" }>): Promise<
    | { coreLines: readonly { variantId: string; qty: number }[];
        addonLines: readonly { variantId: string; qty: number }[]; compositionConstraint: Record<string, unknown> }
    | SubscriptionCommandRefusal>;
}

const refusalCodes = new Set<SubscriptionCommandRefusal["reason"]>([
  "multi_cycle_prepaid_unsupported",
  "subscription_command_addon_not_found",
  "subscription_command_bundle_total_mismatch",
  "subscription_command_charge_timing_not_confirmed",
  "subscription_command_idempotency_conflict",
  "subscription_command_invalid_composition_constraint",
  "subscription_command_invalid_input",
  "subscription_command_not_active",
  "subscription_command_operation_busy",
  "subscription_command_pause_forbidden",
  "subscription_command_payment_blocked",
  "subscription_command_preview_unsupported",
  "subscription_command_renewal_terms_missing",
  "subscription_command_unsupported_action",
  "subscription_edit_catalog_unavailable",
  "subscription_edit_invalid_lines",
  "subscription_edit_invalid_request",
  "subscription_edit_quote_expired",
  "subscription_edit_quote_required",
  "subscription_edit_stale_template",
  "subscription_edit_window_closed",
  "subscription_lifecycle_invalid_transition",
  "subscription_lifecycle_invalid_skip",
  "subscription_lifecycle_invalid_slide",
  "subscription_lifecycle_payment_blocked",
]);
function refusalReason(reason: unknown): SubscriptionCommandRefusal["reason"] {
  return typeof reason === "string" && refusalCodes.has(reason as SubscriptionCommandRefusal["reason"])
    ? reason as SubscriptionCommandRefusal["reason"] : "subscription_command_invalid_input";
}
function commandResult(result: Record<string, unknown>): Record<string, unknown> {
  return result.status === "refused" || result.outcome === "refused"
    ? { ...result, reason: refusalReason(result.reason) } : result;
}

/** N2 owns normalization, locking, quote acceptance, receipts and all writes.
 * Preview is a separate persisted transaction; apply never executes payment. */
export function createPostgresSubscriptionCommandStore(binding: Pick<NativeSubscriptionCommandBinding, "withTransaction">) {
  return {
    preview(input: NativeSubscriptionCommand) { return invokeCommand(binding, input, true); },
    apply(input: NativeSubscriptionCommand) { return invokeCommand(binding, input, false); },
  };
}

async function invokeCommand(binding: Pick<NativeSubscriptionCommandBinding, "withTransaction">,
  input: NativeSubscriptionCommand, preview: boolean,
  futureTerms?: () => ReturnType<NativeSubscriptionCommandBinding["futureTerms"]>): Promise<Record<string, unknown>> {
  if (input.action === "multi_cycle_prepaid") return {
    status: "refused", reason: NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid.refusalCode,
  };
  return binding.withTransaction(async executor => {
    const values = [input.actorId, input.clientId, input.idempotencyKey, input.subscriptionId, input.action, input.payload, input.now];
    // Share N2's actor/key lock so a concurrent preview/apply cannot change
    // the receipt between this read and native dispatch. Replay ends here,
    // before any lifecycle function or other potentially writing call.
    await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [input.actorId, input.idempotencyKey]);
    const stored = await executor.query(`WITH stored AS (
      SELECT r.*, CASE WHEN $9::boolean THEN jsonb_set(r.command,'{payload}',
        (r.command->'payload')-ARRAY['coreLines','addonLines','compositionConstraint']) ELSE r.command END AS requested_command
      FROM public.subscription_command_receipts r WHERE r.actor_id=$1::uuid AND r.idempotency_key=$3::text
        AND $7::timestamptz IS NOT NULL AND isfinite($7::timestamptz)
        AND $3::text=btrim($3::text) AND char_length($3::text) BETWEEN 8 AND 180
        AND $5::text IS NOT NULL AND jsonb_typeof($6::jsonb)='object'
        AND (NOT $8::boolean OR NOT ($6::jsonb ? 'acceptedQuoteHash'))
        AND EXISTS(SELECT 1 FROM public.subscriptions WHERE id=$4::uuid AND client_id=$2::uuid)
    ), receipt AS (
      SELECT *, CASE WHEN $8::boolean OR status='previewed' THEN
        jsonb_set(requested_command,'{payload}',(requested_command->'payload')-'acceptedQuoteHash')=
          jsonb_build_object('clientId',$2::uuid,'subscriptionId',$4::uuid,'action',$5::text,'payload',$6::jsonb-'acceptedQuoteHash')
        ELSE requested_command=jsonb_build_object('clientId',$2::uuid,'subscriptionId',$4::uuid,'action',$5::text,'payload',$6::jsonb)
        END AND ($8::boolean OR quote_hash IS NOT DISTINCT FROM ($6::jsonb->>'acceptedQuoteHash')) AS matches
      FROM stored
    ) SELECT command, CASE WHEN NOT matches THEN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict')
      WHEN $8::boolean OR status='refused' THEN result
      WHEN status<>'previewed' THEN result||jsonb_build_object('status','replayed','originalStatus',status,'commandFingerprint',command_fingerprint)
      END AS response FROM receipt`, [...values, preview, !!futureTerms]);
    if (stored.rows[0]?.response) return commandResult(subscriptionRecord(stored.rows[0].response));
    if (futureTerms) {
      if (stored.rows[0]) {
        // A matching preview already bound the host translation. Apply that
        // exact quote even if the host's mutable policy has since changed.
        values[5] = { ...subscriptionRecord(subscriptionRecord(stored.rows[0].command).payload),
          acceptedQuoteHash: input.payload.acceptedQuoteHash };
      } else {
        const terms = await futureTerms();
        if ("outcome" in terms) return commandResult({ ...terms });
        values[5] = { ...input.payload, ...terms };
      }
    }
    let result: Record<string, unknown> | undefined;
    if (!preview && !Object.hasOwn(input.payload, "acceptedQuoteHash")) {
      // N2 owns every command's no-op decision. Keep only its terminal noop;
      // other direct applies must retain their quote requirement without
      // persisting a speculative quote or refusal from this preview probe.
      await executor.query("SAVEPOINT subscription_command_noop");
      const { rows } = await executor.query("SELECT public.subscription_command_preview($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS response", values);
      const candidate = commandResult(subscriptionRecord(rows[0]?.response));
      if (candidate.status === "noop") result = candidate;
      else await executor.query("ROLLBACK TO SAVEPOINT subscription_command_noop");
      await executor.query("RELEASE SAVEPOINT subscription_command_noop");
    }
    if (!result) {
      const name = preview ? "subscription_command_preview" : "subscription_command_apply";
      const { rows } = await executor.query(`SELECT public.${name}($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS response`, values);
      result = commandResult(subscriptionRecord(rows[0]?.response));
    }
    if (preview || result.status === "refused") return result;
    const receipt = await executor.query(`SELECT command_fingerprint FROM public.subscription_command_receipts
      WHERE actor_id=$1::uuid AND idempotency_key=$2::text`, [input.actorId, input.idempotencyKey]);
    if (typeof receipt.rows[0]?.command_fingerprint !== "string") throw new Error("subscription_command_receipt_missing");
    return { ...result, commandFingerprint: receipt.rows[0].command_fingerprint };
  });
}

/** Trusted customer/operator authorization precedes this adapter. The native
 * result's subscriptionStatus is the state recorded by the original execution,
 * including on replay; it is not a fresh read of mutable subscription state. */
export function createPostgresSubscriptionCommands(binding: NativeSubscriptionCommandBinding): SubscriptionCommandPort & {
  preview(command: Extract<SubscriptionCommand, { action: "edit_future_terms" }>): Promise<Record<string, unknown> | SubscriptionCommandRefusal>;
} {
  function encode(command: SubscriptionCommand): NativeSubscriptionCommand | SubscriptionCommandRefusal {
    // This serving adapter never pauses an active subscription. Existing native
    // callers retain their separate, unchanged lifecycle contract.
    if (command.action === "pause") return { outcome: "refused", reason: "subscription_command_pause_forbidden" };
    const { actor, subscriptionId, idempotencyKey, now, action, ...fields } = command;
    let payload: Record<string, unknown> = { ...fields, actorKind: actor.kind };
    let nativeAction: string = action === "skip" ? "skip_next_cycle" : action === "slide" ? "slide_next_cycle" : action;
    if (command.action === "edit_future_terms") {
      // Preserve the host carriers as well as their native translation in the
      // actual-command fingerprint. The accepted hash is stripped for preview.
      payload = { ...payload, requestedCoreLines: command.coreLines, requestedAddonLines: command.addonLines,
        compositionConstraintRef: command.compositionConstraint };
      delete payload.coreLines;
      delete payload.addonLines;
      delete payload.compositionConstraint;
      nativeAction = "update_package_template";
    }
    return { actorId: actor.actorId, clientId: actor.clientId, subscriptionId, idempotencyKey, now, action: nativeAction, payload };
  }
  return {
    capabilities: NATIVE_SUBSCRIPTION_CAPABILITIES,
    async preview(command) {
      const input = encode(command);
      if ("outcome" in input) return input;
      delete input.payload.acceptedQuoteHash;
      return invokeCommand(binding, input, true, () => binding.futureTerms(command));
    },
    async apply(command) {
      const input = encode(command);
      if ("outcome" in input) return input;
      const result = await invokeCommand(binding, input, false,
        command.action === "edit_future_terms" ? () => binding.futureTerms(command) : undefined);
      if (result.status === "refused" || result.outcome === "refused") return { outcome: "refused", reason: refusalReason(result.reason) };
      if (result.status !== "applied" && result.status !== "replayed" && result.status !== "noop") throw new Error("subscription_command_response_invalid");
      return { actorId: command.actor.actorId, idempotencyKey: command.idempotencyKey,
        commandFingerprint: String(result.commandFingerprint), outcome: result.status, subscriptionId: String(result.subscriptionId),
        originalState: String(result.subscriptionStatus), nextCycleAt: result.nextCycleAt == null ? null : String(result.nextCycleAt),
        revision: String(result.templateVersion), eventId: result.eventId == null ? null : String(result.eventId) } satisfies SubscriptionCommandReceipt;
    },
  };
}
