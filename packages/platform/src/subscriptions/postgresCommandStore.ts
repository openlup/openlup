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

/** N2 owns normalization, locking, quote acceptance, receipts and all writes.
 * Preview is a separate persisted transaction; apply never executes payment. */
export function createPostgresSubscriptionCommandStore(binding: Pick<NativeSubscriptionCommandBinding, "withTransaction">) {
  async function invoke(input: NativeSubscriptionCommand, preview: boolean): Promise<Record<string, unknown>> {
    if (input.action === "multi_cycle_prepaid") return {
      status: "refused", reason: NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid.refusalCode,
    };
    return binding.withTransaction(async executor => {
      const values = [input.actorId, input.clientId, input.idempotencyKey, input.subscriptionId, input.action, input.payload, input.now];
      // Share N2's actor/key lock so a concurrent preview/apply cannot change
      // the receipt between this read and native dispatch. Replay ends here,
      // before any lifecycle function or other potentially writing call.
      await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [input.actorId, input.idempotencyKey]);
      const stored = await executor.query(`WITH receipt AS (
        SELECT r.*, CASE WHEN $8::boolean OR r.status='previewed' THEN
          jsonb_set(r.command,'{payload}',(r.command->'payload')-'acceptedQuoteHash')=
            jsonb_build_object('clientId',$2::uuid,'subscriptionId',$4::uuid,'action',$5::text,'payload',$6::jsonb-'acceptedQuoteHash')
          ELSE r.command=jsonb_build_object('clientId',$2::uuid,'subscriptionId',$4::uuid,'action',$5::text,'payload',$6::jsonb)
          END AND ($8::boolean OR r.quote_hash IS NOT DISTINCT FROM ($6::jsonb->>'acceptedQuoteHash')) AS matches
        FROM public.subscription_command_receipts r WHERE r.actor_id=$1::uuid AND r.idempotency_key=$3::text
          AND $7::timestamptz IS NOT NULL AND isfinite($7::timestamptz)
          AND $3::text=btrim($3::text) AND char_length($3::text) BETWEEN 8 AND 180
          AND $5::text IS NOT NULL AND jsonb_typeof($6::jsonb)='object'
          AND (NOT $8::boolean OR NOT ($6::jsonb ? 'acceptedQuoteHash'))
          AND EXISTS(SELECT 1 FROM public.subscriptions WHERE id=$4::uuid AND client_id=$2::uuid)
      ) SELECT CASE WHEN NOT matches THEN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict')
        WHEN $8::boolean OR status='refused' THEN result
        ELSE result||jsonb_build_object('status','replayed','originalStatus',status,'commandFingerprint',command_fingerprint)
        END AS response FROM receipt WHERE $8::boolean OR status<>'previewed' OR NOT matches`, [...values, preview]);
      if (stored.rows[0]) return subscriptionRecord(stored.rows[0].response);
      const name = preview ? "subscription_command_preview" : "subscription_command_apply";
      const { rows } = await executor.query(`SELECT public.${name}($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS response`,
        values);
      const result = subscriptionRecord(rows[0]?.response);
      if (preview || result.status === "refused") return result;
      const receipt = await executor.query(`SELECT command_fingerprint FROM public.subscription_command_receipts
        WHERE actor_id=$1::uuid AND idempotency_key=$2::text`, [input.actorId, input.idempotencyKey]);
      if (typeof receipt.rows[0]?.command_fingerprint !== "string") throw new Error("subscription_command_receipt_missing");
      return { ...result, commandFingerprint: receipt.rows[0].command_fingerprint };
    });
  }
  return {
    preview(input: NativeSubscriptionCommand) { return invoke(input, true); },
    apply(input: NativeSubscriptionCommand) { return invoke(input, false); },
  };
}

/** Trusted customer/operator authorization precedes this adapter. The native
 * result's subscriptionStatus is the state recorded by the original execution,
 * including on replay; it is not a fresh read of mutable subscription state. */
export function createPostgresSubscriptionCommands(binding: NativeSubscriptionCommandBinding): SubscriptionCommandPort & {
  preview(command: Extract<SubscriptionCommand, { action: "edit_future_terms" }>): Promise<Record<string, unknown> | SubscriptionCommandRefusal>;
} {
  const store = createPostgresSubscriptionCommandStore(binding);
  async function encode(command: SubscriptionCommand): Promise<NativeSubscriptionCommand | SubscriptionCommandRefusal> {
    // This serving adapter never pauses an active subscription. Existing native
    // callers retain their separate, unchanged lifecycle contract.
    if (command.action === "pause") return { outcome: "refused", reason: "subscription_command_pause_forbidden" };
    const { actor, subscriptionId, idempotencyKey, now, action, ...fields } = command;
    let payload: Record<string, unknown> = { ...fields, actorKind: actor.kind };
    let nativeAction: string = action === "skip" ? "skip_next_cycle" : action === "slide" ? "slide_next_cycle" : action;
    if (command.action === "edit_future_terms") {
      const terms = await binding.futureTerms(command);
      if ("outcome" in terms) return terms;
      // Preserve the host carriers as well as their native translation in the
      // actual-command fingerprint. The accepted hash is stripped for preview.
      payload = { ...payload, requestedCoreLines: command.coreLines, requestedAddonLines: command.addonLines,
        compositionConstraintRef: command.compositionConstraint, ...terms };
      nativeAction = "update_package_template";
    }
    return { actorId: actor.actorId, clientId: actor.clientId, subscriptionId, idempotencyKey, now, action: nativeAction, payload };
  }
  return {
    capabilities: NATIVE_SUBSCRIPTION_CAPABILITIES,
    async preview(command) {
      const input = await encode(command);
      if ("outcome" in input) return input;
      delete input.payload.acceptedQuoteHash;
      return store.preview(input);
    },
    async apply(command) {
      const input = await encode(command);
      if ("outcome" in input) return input;
      const result = await store.apply(input);
      if (result.status === "refused") return { outcome: "refused", reason: String(result.reason) };
      if (result.status !== "applied" && result.status !== "replayed" && result.status !== "noop") throw new Error("subscription_command_response_invalid");
      return { actorId: command.actor.actorId, idempotencyKey: command.idempotencyKey,
        commandFingerprint: String(result.commandFingerprint), outcome: result.status, subscriptionId: String(result.subscriptionId),
        originalState: String(result.subscriptionStatus), nextCycleAt: result.nextCycleAt == null ? null : String(result.nextCycleAt),
        revision: String(result.templateVersion), eventId: result.eventId == null ? null : String(result.eventId) } satisfies SubscriptionCommandReceipt;
    },
  };
}
