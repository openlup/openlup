import { createHash } from "node:crypto";
import type { SubscriptionCommand, SubscriptionCommandAdmission, SubscriptionCommandContext, SubscriptionCommandPort, SubscriptionCommandReceipt, SubscriptionCommandRefusal, SubscriptionLifecycleTerms, SubscriptionSaveOfferPresentation } from "./contracts/commands.js";
import { MAX_CADENCE_DAYS } from "@openlup/core/subscription";
import { lifecycleTerms, retentionFields } from "./lifecycleTerms.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "./index.js";

export interface NativeSubscriptionCommand {
  actorId: string; clientId: string; idempotencyKey: string; subscriptionId: string;
  action: string; payload: Record<string, unknown>; now: string;
}
export interface NativeSubscriptionCommandBinding {
  /** Optional effect-free policy. Completed receipts bypass current admission;
   * thrown named errors propagate and roll back without a refusal receipt. */
  admitSubscriptionCommand?: SubscriptionCommandAdmission;
  /** Server-owned timing policy, separate from customer fields. Omit for compatibility timings. */
  lifecycleTerms?: SubscriptionLifecycleTerms;
  /** Optional adopter taxonomy; the package validates shape without owning reason values. */
  retentionReasonCodes?: readonly string[];
  /** The callback must use one connection and commit/rollback the complete unit. */
  withTransaction<T>(work: (executor: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  /** Validate address ownership and refuse address mutation; resolve SKUs and
   * composition policy using trusted host evidence. No current-cycle write. */
  futureTerms(command: Extract<SubscriptionCommand, { action: "edit_future_terms" }>): Promise<
    | { coreLines: readonly { variantId: string; qty: number }[];
        addonLines: readonly { variantId: string; qty: number }[]; compositionConstraint: Record<string, unknown> }
    | SubscriptionCommandRefusal>;
}

const PREVIEW_NOOP_ACTIONS = new Set([
  "slide_next_cycle",
  "update_bundle",
  "resize_bundle",
  "update_package_template",
  "update_plan_length",
  "add_addon",
  "remove_addon",
  "update_addon_quantity",
]);

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
  if (Object.hasOwn(result, "cx1rRequestSha256")) {
    const { cx1rRequestSha256: _privateRequest, ...publicResult } = result;
    result = publicResult;
  }
  return result.status === "refused" || result.outcome === "refused"
    ? { ...result, reason: refusalReason(result.reason) } : result;
}

function lockCommandKey(executor: SubscriptionQueryExecutor, actorId: string, key: string) {
  return executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actorId, key]);
}

function commandValues(input: NativeSubscriptionCommand) {
  return [input.actorId, input.clientId, input.idempotencyKey, input.subscriptionId, input.action, input.payload, input.now];
}

async function dispatchCommand(executor: SubscriptionQueryExecutor, values: unknown[], preview: boolean, terms?: SubscriptionLifecycleTerms) {
  const name = preview ? "subscription_command_preview" : "subscription_command_apply";
  const { rows } = await executor.query(`SELECT public.${name}($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz${terms ? ",$8::jsonb" : ""}) AS response`, terms ? [...values, terms] : values);
  return commandResult(subscriptionRecord(rows[0]?.response));
}

function mappedReceipt(command: SubscriptionCommandContext, result: Record<string, unknown>): SubscriptionCommandReceipt | SubscriptionCommandRefusal {
  if (result.status === "refused" || result.outcome === "refused") return { outcome: "refused", reason: refusalReason(result.reason) };
  if (result.status !== "applied" && result.status !== "replayed" && result.status !== "noop") throw new Error("subscription_command_response_invalid");
  return { actorId: command.actor.actorId, idempotencyKey: command.idempotencyKey,
    commandFingerprint: String(result.commandFingerprint), outcome: result.status, subscriptionId: String(result.subscriptionId),
    originalState: String(result.subscriptionStatus), nextCycleAt: result.nextCycleAt == null ? null : String(result.nextCycleAt),
    revision: String(result.templateVersion), eventId: result.eventId == null ? null : String(result.eventId) };
}

const paymentBlockerSql = (subscription: "$1::uuid" | "s.id") => `COALESCE(
  (SELECT CASE d.status WHEN 'open' THEN 'payment_blocked' ELSE 'payment_expired' END
    FROM public.subscription_dunning_cases d WHERE d.subscription_id=${subscription} AND d.status IN ('open','expired')
    ORDER BY (d.status='open') DESC,d.updated_at DESC,d.id DESC LIMIT 1),
  (SELECT 'payment_failed' FROM public.subscription_cycles c WHERE c.subscription_id=${subscription}
    AND c.status IN ('payment_failed','retry_scheduled') LIMIT 1))`;

async function admitCommand(executor: SubscriptionQueryExecutor, admit: SubscriptionCommandAdmission, input: NativeSubscriptionCommand, status: string) {
  const { rows: [row] } = await executor.query(`SELECT current_setting('transaction_isolation') AS isolation,
    ${paymentBlockerSql("$1::uuid")} AS payment_blocker`, [input.subscriptionId]);
  // Higher isolation retains a pre-lock transaction snapshot. PostgreSQL's
  // READ UNCOMMITTED uses READ COMMITTED's statement snapshots as well.
  if (row.isolation !== "read committed" && row.isolation !== "read uncommitted") {
    throw new Error("subscription_command_admission_isolation_unsupported");
  }
  await admit({ action: admissionAction(input.action),
    pausePreset: typeof input.payload.pausePreset === "string" ? input.payload.pausePreset : null,
    reason: typeof input.payload.reason === "string" ? input.payload.reason : null,
    subscriptionStatus: status, paymentBlocker: row.payment_blocker == null ? null : String(row.payment_blocker) });
}

/** N2 owns normalization, locking, quote acceptance, receipts and all writes.
 * Preview is a separate persisted transaction; apply never executes payment. */
export function createPostgresSubscriptionCommandStore(binding: Pick<NativeSubscriptionCommandBinding, "withTransaction" | "lifecycleTerms" | "retentionReasonCodes" | "admitSubscriptionCommand">) {
  return {
    preview(input: NativeSubscriptionCommand) { return invokeCommand(binding, input, true); },
    apply(input: NativeSubscriptionCommand) { return invokeCommand(binding, input, false); },
  };
}

async function invokeCommand(binding: Pick<NativeSubscriptionCommandBinding, "withTransaction" | "lifecycleTerms" | "retentionReasonCodes" | "admitSubscriptionCommand">,
  input: NativeSubscriptionCommand, preview: boolean,
  futureTerms?: () => ReturnType<NativeSubscriptionCommandBinding["futureTerms"]>): Promise<Record<string, unknown>> {
  if (input.action === "multi_cycle_prepaid") return {
    status: "refused", reason: NATIVE_SUBSCRIPTION_CAPABILITIES.multiCyclePrepaid.refusalCode,
  };
  return binding.withTransaction(async executor => {
    const values = commandValues(input);
    // Share N2's actor/key lock so a concurrent preview/apply cannot change
    // the receipt between this read and native dispatch. Replay ends here,
    // before any lifecycle function or other potentially writing call.
    await lockCommandKey(executor, input.actorId, input.idempotencyKey);
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
    if (binding.admitSubscriptionCommand) {
      // Acquire the lock before taking the payment-facts statement snapshot:
      // a dunning writer can commit after we start waiting without updating s.
      const subscription = await executor.query(`SELECT status FROM public.subscriptions
        WHERE id=$1::uuid AND client_id=$2::uuid FOR UPDATE`, [input.subscriptionId, input.clientId]);
      if (!subscription.rows[0]) throw new Error("subscription_command_forbidden");
      await admitCommand(executor, binding.admitSubscriptionCommand, input, String(subscription.rows[0].status));
    }
    if (["update_package_template", "update_bundle", "resize_bundle", "update_plan_length"].includes(input.action)
      && [input.payload.cadenceDays, input.payload.planDays]
        .some(days => days !== undefined && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_CADENCE_DAYS))) {
      return { status: "refused", reason: "subscription_command_invalid_input" };
    }
    if ((input.action === "pause" || input.action === "cancel") && binding.retentionReasonCodes
      && input.payload.survey !== null && typeof input.payload.survey === "object") {
      const reasonCode = subscriptionRecord(input.payload.survey).reasonCode;
      if (typeof reasonCode === "string" && !binding.retentionReasonCodes.includes(reasonCode)) {
        return { status: "refused", reason: "subscription_command_invalid_input" };
      }
    }
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
    if (!preview && !Object.hasOwn(input.payload, "acceptedQuoteHash") && PREVIEW_NOOP_ACTIONS.has(input.action)) {
      // N2 owns every command's no-op decision. Keep only its terminal noop;
      // other direct applies must retain their quote requirement without
      // persisting a speculative quote or refusal from this preview probe.
      // Actions outside PREVIEW_NOOP_ACTIONS always refuse preview in N2.
      await executor.query("SAVEPOINT subscription_command_noop");
      const { rows } = await executor.query("SELECT public.subscription_command_preview($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS response", values);
      const candidate = commandResult(subscriptionRecord(rows[0]?.response));
      if (candidate.status === "noop") result = candidate;
      else await executor.query("ROLLBACK TO SAVEPOINT subscription_command_noop");
      await executor.query("RELEASE SAVEPOINT subscription_command_noop");
    }
    if (!result) {
      const terms = !preview && binding.lifecycleTerms !== undefined
        && ["pause", "resume", "cancel", "skip_next_cycle", "slide_next_cycle", "order_now", "reactivate"].includes(input.action)
        ? lifecycleTerms(binding.lifecycleTerms) : undefined;
      result = await dispatchCommand(executor, values, preview, terms);
    }
    if (preview || result.status === "refused") return result;
    const receipt = await executor.query(`SELECT command_fingerprint FROM public.subscription_command_receipts
      WHERE actor_id=$1::uuid AND idempotency_key=$2::text`, [input.actorId, input.idempotencyKey]);
    if (typeof receipt.rows[0]?.command_fingerprint !== "string") throw new Error("subscription_command_receipt_missing");
    return { ...result, commandFingerprint: receipt.rows[0].command_fingerprint };
  });
}

function admissionAction(action: string): SubscriptionCommand["action"] {
  switch (action) {
    case "pause": case "resume": case "cancel": case "order_now": case "reactivate": return action;
    case "skip_next_cycle": return "skip";
    case "slide_next_cycle": return "slide";
    case "update_package_template": case "update_bundle": case "resize_bundle": case "update_plan_length":
    case "add_addon": case "remove_addon": case "update_addon_quantity": return "edit_future_terms";
    default: throw new Error("subscription_command_unsupported_action");
  }
}

/** Trusted customer/operator authorization precedes this adapter. The native
 * result's subscriptionStatus is the state recorded by the original execution,
 * including on replay; it is not a fresh read of mutable subscription state. */
export function createPostgresSubscriptionCommands(binding: NativeSubscriptionCommandBinding): SubscriptionCommandPort & {
  preview(command: Extract<SubscriptionCommand, { action: "edit_future_terms" }>): Promise<Record<string, unknown> | SubscriptionCommandRefusal>;
} {
  function encode(command: SubscriptionCommand): NativeSubscriptionCommand | SubscriptionCommandRefusal {
    const { actor, subscriptionId, idempotencyKey, now, action, ...fields } = command;
    let payload: Record<string, unknown> = { ...fields, actorKind: actor.kind };
    if (command.action === "pause" || command.action === "cancel") {
      const retention = retentionFields(command);
      if (!retention) return { outcome: "refused", reason: "subscription_command_invalid_input" };
      payload = { ...payload, ...retention };
    }
    let nativeAction: string = action === "skip" ? "skip_next_cycle" : action === "slide" ? "slide_next_cycle" : action;
    if (command.action === "edit_future_terms") {
      // Preserve the host carriers as well as their native translation in the
      // actual-command fingerprint. The accepted hash is stripped for preview.
      payload = { ...payload, requestedCoreLines: command.coreLines, requestedAddonLines: command.addonLines,
        compositionConstraintRef: command.compositionConstraint };
      delete payload.coreLines;
      delete payload.addonLines;
      delete payload.compositionConstraint;
      // An empty typed hash means no quote; preserve native no-op replay/probing.
      if (command.acceptedQuoteHash === "") delete payload.acceptedQuoteHash;
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
      return mappedReceipt(command, result);
    },
  };
}

type Presentation = SubscriptionSaveOfferPresentation;
type OfferKind = Presentation["kind"];
type PauseOption = Extract<Presentation, { kind: "pause" }>["pausePresets"][number];
type OfferChoice = { kind: "skip" } | { kind: "reschedule"; newNextCycleAt: string } | ({ kind: "pause" } & PauseOption);
type OfferAcceptance = SubscriptionCommandContext & { generation: string } & OfferChoice;
type OfferBinding = Pick<NativeSubscriptionCommandBinding, "withTransaction" | "admitSubscriptionCommand"> & {
  lifecycleTerms: SubscriptionLifecycleTerms;
  offerPolicy: {
    offerPresentation: "ask_permission_first" | "off";
    defaultOffer: OfferKind;
    allowedPausePresets: readonly PauseOption["pausePreset"][];
    preselectedPausePreset: PauseOption["pausePreset"];
    rescheduleOfferDays: number;
  };
};
type OfferRefusal = { outcome: "refused"; reason:
  "subscription_save_offer_unavailable" | "subscription_save_offer_stale" | "subscription_save_offer_consumed" };

const offerDigest = (fields: readonly unknown[]) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

function chosenTerms(choice: OfferChoice) {
  if (choice.kind === "skip") return [];
  if (choice.kind === "reschedule") return [choice.newNextCycleAt];
  const { duration, pausePreset } = choice;
  return duration.unit === "indefinite" ? [pausePreset, duration.unit] : [pausePreset, duration.unit, duration.value];
}

function offerCommand(input: SubscriptionCommandContext, choice: OfferChoice): NativeSubscriptionCommand {
  const payload: Record<string, unknown> = { actorKind: input.actor.kind, reason: null };
  if (choice.kind === "pause") Object.assign(payload, { pausePreset: choice.pausePreset, survey: null, saveOffer: null });
  else {
    payload.confirmedChargeTiming = false;
    if (choice.kind === "reschedule") payload.newNextCycleAt = choice.newNextCycleAt;
  }
  return { actorId: input.actor.actorId, clientId: input.actor.clientId, subscriptionId: input.subscriptionId,
    idempotencyKey: input.idempotencyKey, now: input.now, payload,
    action: { skip: "skip_next_cycle", reschedule: "slide_next_cycle", pause: "pause" }[choice.kind] };
}

async function readOfferState(executor: SubscriptionQueryExecutor, actor: SubscriptionCommandContext["actor"],
  ids: readonly string[], now: string, kind: OfferKind, binding: OfferBinding, presenting = false) {
  const policy = binding.offerPolicy;
  const { slideMinDays, slideMaxDays } = binding.lifecycleTerms;
  const { rows } = await executor.query(`SELECT s.id::text, s.client_id::text, $8::uuid::text AS actor_id,
      s.status, s.template_version::text, rt.next_cycle_number::text,
      CASE WHEN isfinite(s.next_cycle_at)
        THEN to_char(s.next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS next_cycle_at,
      CASE WHEN target.at BETWEEN $3::timestamptz + make_interval(days=>$6::integer)
                              AND $3::timestamptz + make_interval(days=>$7::integer)
        THEN to_char(target.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS slide_target,
      $3::timestamptz <= s.next_cycle_at - make_interval(hours=>s.edit_window_hours) AS edit_open,
      ${paymentBlockerSql("s.id")} AS payment_blocker,
      CASE WHEN $9::boolean AND $4::text IN ('skip','reschedule') THEN
        (CASE WHEN public.subscription_method_uses_recorded_refs(s.id)
          THEN public.subscription_method_chargeable_unattended(s.id,now())
          ELSE EXISTS (SELECT 1 FROM public.subscription_method_states m WHERE m.subscription_id=s.id AND m.health_state='healthy') END)
        AND NOT EXISTS (SELECT 1 FROM public.subscription_cycles c
          LEFT JOIN public.commerce_orders orders ON orders.subscription_cycle_id=c.id
          WHERE c.subscription_id=s.id AND c.scheduled_at=s.next_cycle_at
            AND (c.status IN ('payment_pending','paid') OR orders.status IN ('paid','fulfillment_pending','fulfilled')))
        ELSE true END AS action_available,
      marker.key AS marker_key, event.id IS NOT NULL AS consumed
    FROM public.subscriptions s
    LEFT JOIN public.subscription_renewal_terms rt ON rt.subscription_id=s.id
    CROSS JOIN LATERAL (SELECT CASE WHEN isfinite(s.next_cycle_at)
      THEN s.next_cycle_at + $5::integer * interval '24 hours' END AS at) target
    CROSS JOIN LATERAL (SELECT CASE WHEN rt.next_cycle_number IS NOT NULL THEN
      'save-offer:v1:' || encode(sha256(convert_to(
        format('["cx1r-occurrence-v1","%s","%s","%s"]',s.id,$4::text,rt.next_cycle_number),'UTF8')),'hex') END AS key) marker
    LEFT JOIN public.subscription_events event ON event.subscription_id=s.id AND event.idempotency_key=marker.key
    WHERE s.client_id=$1::uuid AND s.id=ANY($2::uuid[])`,
  [actor.clientId, ids, now, kind, policy.defaultOffer === "reschedule" ? policy.rescheduleOfferDays : null,
    slideMinDays, slideMaxDays, actor.actorId, presenting]);
  return rows;
}

function derivePresentation(row: Record<string, unknown> | undefined, binding: OfferBinding): Presentation | null {
  const policy = binding.offerPolicy;
  if (!row || row.status !== "active" || row.next_cycle_number == null || typeof row.next_cycle_at !== "string"
    || policy.offerPresentation !== "ask_permission_first") return null;
  if (policy.defaultOffer !== "pause" && !row.edit_open) return null;
  if (policy.defaultOffer === "reschedule" && typeof row.slide_target !== "string") return null;
  const terms = lifecycleTerms(binding.lifecycleTerms);
  const generation = offerDigest(["cx1r-presentation-v1", row.actor_id, row.client_id, row.id, row.status,
    row.next_cycle_number, row.template_version, row.next_cycle_at, policy.offerPresentation, policy.defaultOffer,
    policy.allowedPausePresets, policy.preselectedPausePreset, policy.rescheduleOfferDays,
    terms.pauseDays, terms.pauseMonths, terms.slideMinDays, terms.slideMaxDays]);
  const base = { generation, subscriptionRef: String(row.id) };
  if (policy.defaultOffer === "skip") return { ...base, kind: "skip" };
  if (policy.defaultOffer === "reschedule") return { ...base, kind: "reschedule", newNextCycleAt: String(row.slide_target) };
  if (!policy.allowedPausePresets.includes(policy.preselectedPausePreset)) return null;
  const durations: Record<PauseOption["pausePreset"], PauseOption["duration"]> = {
    "2_weeks": { unit: "days", value: terms.pauseDays },
    "1_month": { unit: "months", value: terms.pauseMonths },
    indefinite: { unit: "indefinite" },
  };
  return { ...base, kind: "pause", preselectedPausePreset: policy.preselectedPausePreset,
    pausePresets: policy.allowedPausePresets.map(pausePreset => ({ pausePreset, duration: durations[pausePreset] })) };
}

function matchesPresentation(presentation: Presentation, input: OfferAcceptance) {
  if (presentation.generation !== input.generation || presentation.kind !== input.kind) return false;
  if (presentation.kind === "pause" && input.kind === "pause") return presentation.pausePresets.some(option =>
    JSON.stringify(chosenTerms({ kind: "pause", ...option })) === JSON.stringify(chosenTerms(input)));
  if (presentation.kind === "reschedule" && input.kind === "reschedule") return presentation.newNextCycleAt === input.newNextCycleAt;
  return true;
}

/** @experimental Present and accept one native save offer per kind and logical renewal.
 * Bind an authenticated actor and a READ COMMITTED transaction on one connection. */
export function createPostgresSubscriptionSaveOfferAcceptor(binding: OfferBinding) {
  return {
    async readPresentations({ actor, subscriptionIds, now }: {
      actor: SubscriptionCommandContext["actor"]; subscriptionIds: readonly string[]; now: string;
    }): Promise<Map<string, Presentation | null>> {
      if (subscriptionIds.length === 0) return new Map();
      const rows = await binding.withTransaction(db => readOfferState(db, actor, subscriptionIds, now, binding.offerPolicy.defaultOffer, binding, true));
      const presentations = new Map<string, Presentation | null>();
      for (const row of rows) {
        let presentation = row.consumed || !row.action_available ? null : derivePresentation(row, binding);
        if (presentation && presentation.kind !== "pause" && row.payment_blocker === "payment_blocked") presentation = null;
        if (presentation && binding.admitSubscriptionCommand) {
          try {
            await binding.admitSubscriptionCommand({
              action: presentation.kind === "reschedule" ? "slide" : presentation.kind,
              pausePreset: presentation.kind === "pause" ? presentation.preselectedPausePreset : null,
              reason: null, subscriptionStatus: String(row.status),
              paymentBlocker: row.payment_blocker == null ? null : String(row.payment_blocker),
            });
          } catch (error) {
            if (!(error instanceof Error) || !/^[a-z][a-z0-9_]*$/u.test(error.message)) throw error;
            presentation = null;
          }
        }
        presentations.set(String(row.id), presentation);
      }
      return presentations;
    },
    async accept(input: OfferAcceptance): Promise<SubscriptionCommandReceipt | SubscriptionCommandRefusal | OfferRefusal> {
      if (!/^[a-zA-Z0-9-]{16,100}$/u.test(input.idempotencyKey)) return { outcome: "refused", reason: "subscription_command_invalid_input" };
      return binding.withTransaction(async db => {
        const { actor, subscriptionId, now, generation, kind } = input;
        const key = `save-offer-accept:v1:${input.idempotencyKey}`;
        await lockCommandKey(db, actor.actorId, key);
        const { rows: [owned] } = await db.query(`SELECT id::text, client_id::text, status,
          $3::uuid::text AS actor_id, current_setting('transaction_isolation') AS isolation
          FROM public.subscriptions WHERE id=$1::uuid AND client_id=$2::uuid FOR UPDATE`, [subscriptionId, actor.clientId, actor.actorId]);
        const { rows: [stored] } = await db.query(`SELECT subscription_id::text, client_id::text, command_fingerprint, result, status
          FROM public.subscription_command_receipts WHERE actor_id=$1::uuid AND idempotency_key=$2::text`, [actor.actorId, key]);
        if (!owned) return { outcome: "refused", reason: stored
          ? "subscription_command_idempotency_conflict" : "subscription_save_offer_unavailable" };
        if (owned.isolation !== "read committed") throw new Error("subscription_command_admission_isolation_unsupported");
        const digest = offerDigest(["cx1r-accept-v1", owned.actor_id, owned.client_id, owned.id, generation, kind, chosenTerms(input)]);
        if (stored) {
          const result = subscriptionRecord(stored.result);
          if (stored.subscription_id !== owned.id || stored.client_id !== owned.client_id ||
            result.cx1rRequestSha256 !== digest || stored.status === "previewed") {
            return { outcome: "refused", reason: "subscription_command_idempotency_conflict" };
          }
          return mappedReceipt(input, { ...result, status: stored.status === "refused" ? "refused" : "replayed",
            commandFingerprint: stored.command_fingerprint });
        }
        await db.query("SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=$1::uuid FOR UPDATE", [subscriptionId]);
        const [row] = await readOfferState(db, actor, [subscriptionId], now, kind, binding);
        if (row?.consumed) return { outcome: "refused", reason: "subscription_save_offer_consumed" };
        const offer = derivePresentation(row, binding);
        if (!offer) return { outcome: "refused", reason: "subscription_save_offer_unavailable" };
        if (!matchesPresentation(offer, input)) return { outcome: "refused", reason: "subscription_save_offer_stale" };

        const terms = lifecycleTerms(binding.lifecycleTerms);
        const native = offerCommand({ ...input, idempotencyKey: key }, input);
        if (binding.admitSubscriptionCommand) await admitCommand(db, binding.admitSubscriptionCommand, native, String(owned.status));
        // Direct N2 apply gives semantic no-ops the native payment fences too.
        const result = await dispatchCommand(db, commandValues(native), false, terms);
        const { rows: [receipt] } = await db.query(`UPDATE public.subscription_command_receipts
          SET result=result || jsonb_build_object('cx1rRequestSha256',$3::text)
          WHERE actor_id=$1::uuid AND idempotency_key=$2::text AND status=$4::text
          RETURNING command_fingerprint`, [actor.actorId, key, digest, result.status]);
        if (typeof receipt?.command_fingerprint !== "string") throw new Error("subscription_command_receipt_missing");
        if (result.status === "applied" || result.status === "noop") {
          const marker = await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
            VALUES($1::uuid,'subscription.save_offer_accepted',$2::text,
              jsonb_build_object('kind',$3::text,'nextCycleNumber',$4::text),$5::timestamptz) RETURNING id`,
          [subscriptionId, row.marker_key, kind, row.next_cycle_number, now]);
          if (!marker.rows.length) throw new Error("subscription_save_offer_marker_missing");
        }
        return mappedReceipt(input, { ...result, commandFingerprint: receipt.command_fingerprint });
      });
    },
  };
}
