import { z } from "zod";
import type { PackageEditActor, PackageEditBlockedReason } from "./packageEditContracts.js";
import type { SizedEditApplyResult, SizedEditContext, SizedEditPreview, SizedEditRequest } from "./contracts/sizedEdit.js";
import { SIZED_PARCEL_LEVER_KIND } from "./sizedParcelLever.js";
import type { SizedEditorOptions } from "./sizedEditPorts.js";
import { createSizedEditContextScope, isSizedOptIn, normalizeSizedEdit, readSizedEditContext } from "./sizedEditContext.js";
import { assertSizedPolicy } from "./sizedComposition.js";
import { assertSizedSubjectFacts, quoteSizedEdit, sizedCandidateCompatibility } from "./sizedEditQuote.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { mapPackageEditError } from "./packageEditErrors.js";

/** The host composes this alongside its existing classic binding. One callback owns one connection through commit. */
export function createPostgresSizedEditor(options: SizedEditorOptions) {
  assertSizedPolicy(options.policy);
  const policy = options.policy;
  const uuid = z.uuid().transform(value => value.toLowerCase());
  const line = z.object({ variantId: uuid, qty: z.number().int().positive().max(policy.maximumQuantity) }).strict();
  const acceptance = { subscriptionId: uuid, expectedTemplateVersion: z.number().int().positive().optional(), acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() };
  const constraint = z.record(z.string(), z.unknown());
  const parcel = z.object({ kind: z.literal(SIZED_PARCEL_LEVER_KIND), value: z.object({ coreLines: z.array(line).min(1).max(policy.maximumCoreLines), optInToSized: z.literal(true).optional() }).strict() }).strict();
  const schema = z.discriminatedUnion("action", [
    z.object({ ...acceptance, action: z.literal("resize_bundle"), cadenceDays: z.number().int().positive(), compositionConstraint: constraint,
      resizeLever: z.union([parcel, z.object({ kind: z.literal("portionMode"), value: z.object({ portionMode: z.string().min(1), planDays: z.number().int().positive() }).strict() }).strict()]) }).strict(),
    z.object({ ...acceptance, action: z.literal("update_bundle"), coreLines: z.array(line).min(1).max(policy.maximumCoreLines),
      addonLines: z.array(line).max(policy.maximumAddonLines).optional(), cadenceDays: z.number().int().positive().optional(), compositionConstraint: constraint }).strict(),
    z.object({ ...acceptance, action: z.literal("update_base_mix"), base: z.array(line).min(1).max(policy.maximumCoreLines) }).strict(),
    z.object({ ...acceptance, action: z.literal("update_plan_length"), planDays: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("update_portion"), portionMode: z.string().min(1) }).strict(),
    z.object({ ...acceptance, action: z.literal("add_addon"), variantId: uuid, qty: z.number().int().positive().max(policy.maximumQuantity) }).strict(),
    z.object({ ...acceptance, action: z.literal("update_addon_quantity"), variantId: uuid, qty: z.number().int().positive().max(policy.maximumQuantity) }).strict(),
    z.object({ ...acceptance, action: z.literal("remove_addon"), variantId: uuid }).strict(),
  ]);
  const parse = (request: unknown): SizedEditRequest => {
    const result = schema.safeParse(request);
    if (!result.success) throw new Error("subscription_reprice_invalid_request"); return result.data;
  };
  async function owned(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string) {
    const row = (await db.query(`SELECT s.*,
      EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open') AS payment_blocked,
      EXISTS(SELECT 1 FROM public.subscription_cycles c LEFT JOIN public.commerce_orders o ON o.subscription_cycle_id=c.id
       WHERE c.subscription_id=s.id AND c.scheduled_at=s.next_cycle_at AND (c.status IN ('payment_pending','paid') OR o.status IN ('paid','fulfillment_pending','fulfilled'))) AS cycle_locked,
      EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') AS method_healthy
      FROM public.subscriptions s WHERE s.id=$1::uuid AND s.client_id=$2::uuid`, [id, actor.clientId])).rows[0];
    if (!row) throw new Error("subscription_command_forbidden");
    if (row.configured_offer_version !== "classic" && row.configured_offer_version !== "sized.v1") throw new Error("subscription_edit_invalid_offer_binding");
    return row;
  }
  async function replay(db: SubscriptionQueryExecutor, actor: PackageEditActor, key: string, request: SizedEditRequest): Promise<SizedEditApplyResult | null> {
    const { subscriptionId, ...payload } = request;
    const prior = (await db.query(`SELECT r.*,r.command=jsonb_build_object('clientId',$1::uuid,'subscriptionId',$2::uuid,
      'action',$3::text,'payload',$4::jsonb) AND r.quote_hash IS NOT DISTINCT FROM ($4::jsonb->>'acceptedQuoteHash') AS matches
      FROM public.subscription_command_receipts r WHERE r.actor_id=$5::uuid AND r.idempotency_key=$6::text`,
    [actor.clientId, subscriptionId, request.action, payload, actor.actorId, key])).rows[0];
    if (!prior) return null;
    if (!prior.matches || !["applied", "noop", "refused"].includes(String(prior.status))) throw new Error("subscription_command_idempotency_conflict");
    const result = subscriptionRecord(prior.result);
    if (prior.status === "refused") throw new Error(String(result.reason));
    return { ...result, status: "replayed", originalStatus: prior.status } as SizedEditApplyResult;
  }
  const scope = (db: SubscriptionQueryExecutor, actor: PackageEditActor) => createSizedEditContextScope((id, optIn) => readSizedEditContext(db, actor.clientId, id, optIn));
  async function quote(db: SubscriptionQueryExecutor, context: SizedEditContext, request: SizedEditRequest, point: "preview" | "apply") {
    if (request.expectedTemplateVersion !== undefined && request.expectedTemplateVersion !== context.templateVersion) throw new Error("subscription_edit_stale_template");
    return quoteSizedEdit({ db, context, request, point, host: options, policy });
  }
  function blocked(row: Record<string, unknown>, request: SizedEditRequest): SizedEditPreview {
    const next = row.next_cycle_at instanceof Date ? row.next_cycle_at.toISOString() : row.next_cycle_at == null ? null : String(row.next_cycle_at);
    const cutoff = next ? new Date(Date.parse(next) - Number(row.edit_window_hours) * 3_600_000).toISOString() : null;
    const reason: PackageEditBlockedReason | null = row.payment_blocked ? "payment_blocked" : row.status !== "active" ? "not_active"
      : row.cycle_locked ? "cycle_locked" : !row.method_healthy ? "missing_payment_method" : cutoff && Date.parse(cutoff) <= Date.parse(options.now()) ? "edit_window_closed" : null;
    return { preview: { subscriptionId: request.subscriptionId, action: request.action, canApply: reason === null, blockedReason: reason,
      nextCycleAt: next, editCutoffAt: cutoff, templateVersion: Number(row.template_version) },
    lockedCycle: { locked: reason === "cycle_locked" || reason === "payment_blocked", status: reason === "cycle_locked" ? "blocked_preflight" : reason === "payment_blocked" ? "dunning" : null },
    futureTemplate: { templateVersion: Number(row.template_version), effectiveCycleAt: next, priceAgreementPolicy: "lock_until_edit" } };
  }
  return {
    async candidates(actor: PackageEditActor, id: string, optIn = false) {
      return options.withTransaction(async db => {
        await owned(db, actor, id);
        const context = await scope(db, actor)(id, optIn), facts = await options.readFacts(db, context, "candidate");
        assertSizedSubjectFacts(facts, context, policy);
        if (optIn && context.binding === "classic") {
          const need = await options.resolveOptInNeed(db, context);
          if (!Number.isSafeInteger(need.dailyNeed) || need.dailyNeed <= 0) throw new Error("subscription_reprice_sized_need_unreadable");
          context.compositionConstraint = { kind: "unit_count", value: context.lines.filter(line => !line.isAddon).reduce((total, line) => total + line.qty, 0), dailyNeed: need.dailyNeed,
            ...(context.compositionConstraint?.mode === policy.portionModes.reduced.mode ? { mode: policy.portionModes.reduced.mode, portionFactor: policy.portionModes.reduced.factor } : {}) };
        }
        return { context, catalog: sizedCandidateCompatibility(await options.readCatalog(db, context), facts) };
      });
    },
    async preview(actor: PackageEditActor, input: SizedEditRequest): Promise<SizedEditPreview> {
      const parsed = parse(input);
      if (parsed.acceptedQuoteHash !== undefined) throw new Error("subscription_reprice_invalid_request");
      return options.withTransaction(async db => {
        const row = await owned(db, actor, parsed.subscriptionId);
        const context = await scope(db, actor)(parsed.subscriptionId, isSizedOptIn(parsed));
        const request = normalizeSizedEdit(parsed, context, policy), preview = blocked(row, request);
        if (!preview.preview.canApply) return preview;
        const priced = await quote(db, context, request, "preview"), { subscriptionId: _id, ...raw } = request;
        const expires = new Date(Date.parse(options.now()) + 15 * 60_000).toISOString();
        await db.query("SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::integer,$7::timestamptz,$8::jsonb,$9::jsonb,$10::jsonb,$11::timestamptz)",
          [actor.actorId, actor.clientId, request.subscriptionId, request.action, priced.quoteHash, priced.expectedTemplateVersion, expires, raw,
            { lines: priced.lines, cadenceDays: priced.cadenceDays, compositionConstraint: priced.compositionConstraint, subjectFacts: { ...priced.subjectFacts, catalogFacts: priced.catalogFacts }, optInFacts: priced.optInFacts },
            { currentRecurringPrice: priced.currentRecurringPrice, newRecurringPrice: priced.newRecurringPrice, delta: priced.delta }, options.now()]);
        return { ...preview, quoteHash: priced.quoteHash, quoteExpiresAt: expires, currentTotal: priced.currentRecurringPrice,
          newTotal: priced.newRecurringPrice, delta: priced.delta, packageEdit: { currentRecurringPrice: priced.currentRecurringPrice,
            newRecurringPrice: priced.newRecurringPrice, delta: priced.delta, quoteHash: priced.quoteHash,
            effectiveCycleAt: preview.preview.nextCycleAt, priceAgreementPolicy: "lock_until_edit" } };
      });
    },
    async apply(actor: PackageEditActor, key: string, input: SizedEditRequest): Promise<SizedEditApplyResult> {
      const parsed = parse(input);
      if (key !== key.trim() || key.length < 8 || key.length > 180) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actor.actorId, key]);
        await owned(db, actor, parsed.subscriptionId);
        const stored = await replay(db, actor, key, parsed);
        if (stored) return stored;
        const context = await scope(db, actor)(parsed.subscriptionId, isSizedOptIn(parsed));
        const request = normalizeSizedEdit(parsed, context, policy), priced = await quote(db, context, request, "apply");
        if (request.acceptedQuoteHash !== priced.quoteHash) throw new Error("subscription_reprice_quote_not_accepted");
        const addon = ["add_addon", "remove_addon", "update_addon_quantity"].includes(request.action);
        if (!addon) await options.assertCurrentFacts(db, context, priced.subjectFacts, priced.optInFacts, priced.catalogFacts);
        const { subscriptionId: _id, ...raw } = request;
        const payload = { ...raw, request: raw, lines: priced.lines, cadenceDays: priced.cadenceDays, compositionConstraint: priced.compositionConstraint,
          subjectFacts: { ...priced.subjectFacts, catalogFacts: priced.catalogFacts }, optInFacts: priced.optInFacts, expectedTemplateVersion: priced.expectedTemplateVersion };
        const result = subscriptionRecord((await (addon ? db.query("SELECT public.subscription_line_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS result",
          [actor.actorId, actor.clientId, key, request.subscriptionId, request.action, payload, options.now()])
          : db.query("SELECT public.subscription_sized_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::timestamptz) AS result",
            [actor.actorId, actor.clientId, key, request.subscriptionId, payload, options.now()]))).rows[0]?.result);
        if (result.status === "refused") throw new Error(String(result.reason));
        return result as unknown as SizedEditApplyResult;
      });
    },
  };
}
/** Binding dispatch does not read sized context for lifecycle or ordinary classic operations. */
export function createOfferDispatchedSubscriptionEditor(input: {
  readBinding(actor: PackageEditActor, id: string): Promise<"classic" | "sized.v1" | null>;
  classic: { preview(actor: PackageEditActor, request: never): Promise<unknown>; apply(actor: PackageEditActor, key: string, request: never): Promise<unknown> };
  sized: ReturnType<typeof createPostgresSizedEditor>;
}) {
  const content = new Set(["resize_bundle", "update_bundle", "update_base_mix", "update_plan_length", "update_portion", "update_package_template", "swap_base_line", "add_addon", "remove_addon", "update_addon_quantity"]);
  async function choose(actor: PackageEditActor, request: { subscriptionId: string; action?: string }) {
    const binding = await input.readBinding(actor, request.subscriptionId);
    if (!binding) throw new Error("subscription_command_forbidden");
    if (binding !== "classic" && binding !== "sized.v1") throw new Error("subscription_edit_invalid_offer_binding");
    if (binding === "classic" && !isSizedOptIn({ ...request, action: request.action ?? "update_package_template" })) return input.classic;
    if (["update_package_template", "swap_base_line"].includes(request.action ?? "update_package_template")) throw new Error("subscription_reprice_configured_offer_action_mismatch");
    return content.has(request.action ?? "") ? input.sized : input.classic;
  }
  return {
    async preview(actor: PackageEditActor, request: { subscriptionId: string; action?: string }) {
      const editor = await choose(actor, request); return editor.preview(actor, request as never);
    },
    async apply(actor: PackageEditActor, key: string, request: { subscriptionId: string; action?: string }) {
      const editor = await choose(actor, request); return editor.apply(actor, key, request as never);
    },
  };
}
export function mapSizedEditError(error: unknown, phase: "preview" | "apply", action?: string) {
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
  if (/subscription_(?:edit_invalid_intro_fixed|edit_invalid_graduation_addon|configured_offer_immutable)/u.test(message)) {
    return { status: 409 as const, code: "CONFLICT" as const, message: "Customer subscription action is not allowed", reason: message };
  }
  if (["subscription_edit_invalid_agreed_price", "subscription_edit_invalid_intro_marker"].includes(message)) {
    return mapPackageEditError(new Error(message === "subscription_edit_invalid_agreed_price" ? "subscription_reprice_sized_agreed_price_unreadable" : "subscription_reprice_sized_marker_unreadable"), phase, action);
  }
  return mapPackageEditError(error, phase, action);
}
