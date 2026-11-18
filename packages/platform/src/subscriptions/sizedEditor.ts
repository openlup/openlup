import { z } from "zod";
import { assertEditIntent, assertEditQuoteCurrency, buildEditConsent, consentRequest, decodeEditResult, hashEditConsent, isEditContentNoop, readEditCatalogEvidence, readEditReceipt, takeEditConsent } from "./editConsent.js";
import { readCompleteEditBaseline, type EditAgreementBaseline } from "./editConsentBaseline.js";
import type { PackageEditActor } from "./packageEditContracts.js";
import type { SizedEditApplyResult, SizedEditContext, SizedEditPreview, SizedEditRequest } from "./contracts/sizedEdit.js";
import { SIZED_PARCEL_LEVER_KIND } from "./sizedParcelLever.js";
import type { SizedEditorOptions } from "./sizedEditPorts.js";
import { isSizedOptIn, normalizeSizedEdit, readSizedConsentPhase, readSizedEditContext } from "./sizedEditContext.js";
import { assertSizedPolicy } from "./sizedComposition.js";
import { assertSizedSubjectFacts, quoteSizedEdit, sizedCandidateCompatibility } from "./sizedEditQuote.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { mapPackageEditError } from "./packageEditErrors.js";
import { assertEditVersion, assertFreshEditEligible, editPreviewEligibility, readEditEligibility, readOwnedEditVersion } from "./packageEditRead.js";

function canNormalizeToResize(action: string) {
  return action === "update_portion" || action === "update_base_mix" || action === "update_bundle";
}

/** The host composes this alongside its existing classic binding. One callback owns one connection through commit. */
export function createPostgresSizedEditor(options: SizedEditorOptions) {
  assertSizedPolicy(options.policy);
  const policy = options.policy;
  const uuid = z.uuid().transform(value => value.toLowerCase());
  const line = z.object({ variantId: uuid, qty: z.number().int().positive() }).strict();
  const acceptance = { subscriptionId: uuid, expectedTemplateVersion: z.number().int().positive().optional(), acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() };
  const constraint = z.record(z.string(), z.unknown());
  const parcel = z.object({ kind: z.literal(SIZED_PARCEL_LEVER_KIND), value: z.object({ coreLines: z.array(line).min(1), optInToSized: z.literal(true).optional() }).strict() }).strict();
  const schema = z.discriminatedUnion("action", [
    z.object({ ...acceptance, action: z.literal("resize_bundle"), cadenceDays: z.number().int().positive(), compositionConstraint: constraint,
      resizeLever: z.union([parcel, z.object({ kind: z.literal("portionMode"), value: z.object({ portionMode: z.string().min(1), planDays: z.number().int().positive() }).strict() }).strict()]) }).strict(),
    z.object({ ...acceptance, action: z.literal("update_bundle"), coreLines: z.array(line).min(1),
      addonLines: z.array(line).optional(), cadenceDays: z.number().int().positive().optional(), compositionConstraint: constraint }).strict(),
    z.object({ ...acceptance, action: z.literal("update_base_mix"), base: z.array(line).min(1) }).strict(),
    z.object({ ...acceptance, action: z.literal("update_plan_length"), planDays: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("update_portion"), portionMode: z.string().min(1) }).strict(),
    z.object({ ...acceptance, action: z.literal("add_addon"), variantId: uuid, qty: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("update_addon_quantity"), variantId: uuid, qty: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("remove_addon"), variantId: uuid }).strict(),
  ]);
  const parse = (request: unknown): SizedEditRequest => {
    const result = schema.safeParse(request);
    if (!result.success) throw new Error("subscription_reprice_invalid_request"); return result.data;
  };
  function assertRequestLimits(request: SizedEditRequest) {
    const core = "coreLines" in request ? request.coreLines : "base" in request ? request.base
      : request.action === "resize_bundle" && request.resizeLever.kind === SIZED_PARCEL_LEVER_KIND ? request.resizeLever.value.coreLines : [];
    const addons = "addonLines" in request ? request.addonLines ?? [] : [];
    if (core.length > policy.maximumCoreLines || addons.length > policy.maximumAddonLines ||
      [...core, ...addons].some(line => line.qty > policy.maximumQuantity) || ("qty" in request && request.qty > policy.maximumQuantity)) {
      throw new Error("subscription_reprice_invalid_request");
    }
  }
  function assertBinding(row: Record<string, unknown>) {
    if (row.configured_offer_version !== "classic" && row.configured_offer_version !== "sized.v1") throw new Error("subscription_edit_invalid_offer_binding");
  }
  async function replay(db: SubscriptionQueryExecutor, actor: PackageEditActor, key: string, request: SizedEditRequest): Promise<SizedEditApplyResult | null> {
    const { subscriptionId, ...payload } = request;
    const stored = await readEditReceipt(db, actor, subscriptionId, key, request.action, payload);
    if (!stored) return null;
    const action = canNormalizeToResize(request.action) && stored.result.action === "resize_bundle" ? "resize_bundle" : request.action;
    return decodeEditResult(stored.rows, "result", subscriptionId, action, stored.status);
  }
  const phase = (db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string) => readSizedConsentPhase(db,actor.clientId,id);
  async function editContext(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string, optIn: boolean,
    numberedPhase: Awaited<ReturnType<typeof readSizedConsentPhase>>): Promise<SizedEditContext> {
    return { ...await readSizedEditContext(db,actor.clientId,id,optIn),numberedPhase };
  }
  async function quote(db: SubscriptionQueryExecutor, context: SizedEditContext, request: SizedEditRequest, point: "preview" | "apply", baseline: EditAgreementBaseline, current: Record<string, unknown>) {
    if (request.expectedTemplateVersion !== undefined && request.expectedTemplateVersion !== context.templateVersion) throw new Error("subscription_edit_stale_template");
    assertEditIntent(baseline, request);
    const host: SizedEditorOptions = { ...options, quotePort: { async createServerAuthoritativeQuote(input) {
      const result = await options.quotePort.createServerAuthoritativeQuote(input);
      assertEditQuoteCurrency(baseline.currency, result.quote); return result;
    } } };
    const quote = await quoteSizedEdit({ db, context, request, point, host, policy });
    const keepAgreement = isEditContentNoop({ lane: ["add_addon", "remove_addon", "update_addon_quantity"].includes(request.action) ? "exact" : "sized",
      action: request.action, request, baseline, desired: quote.lines, current, cadenceDays: quote.cadenceDays,
      constraint: quote.compositionConstraint, optIn: isSizedOptIn(request) });
    const editConsent = buildEditConsent(baseline, quote.quoteHash, quote.lines, keepAgreement);
    return { ...quote, editConsent, quoteHash: hashEditConsent(editConsent),
      currentRecurringPrice: { amountMinor: editConsent.agreedTotalMinor, currency: editConsent.currency },
      newRecurringPrice: { amountMinor: editConsent.newTotalMinor, currency: editConsent.currency },
      delta: { amountMinor: editConsent.subtotalDeltaMinor, currency: editConsent.currency } };
  }
  return {
    /** Used before binding dispatch to preserve an owned historical receipt. @experimental */
    async replayCompleted(actor: PackageEditActor, key: string, request: unknown) {
      const parsed = schema.safeParse(request);
      if (!parsed.success || key !== key.trim() || key.length < 8 || key.length > 180) return null;
      return options.withTransaction(async db => {
        await readOwnedEditVersion(db, actor, parsed.data.subscriptionId, false);
        return replay(db, actor, key, parsed.data);
      });
    },
    async candidates(actor: PackageEditActor, id: string, optIn = false) {
      return options.withTransaction(async db => {
        await readOwnedEditVersion(db,actor,id,true);
        assertBinding(await readEditEligibility(db, actor, id));
        const context = await editContext(db,actor,id,optIn,await phase(db,actor,id));
        const facts = await options.readFacts(db, context, "candidate");
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
      assertRequestLimits(parsed);
      if (parsed.acceptedQuoteHash !== undefined) throw new Error("subscription_reprice_invalid_request");
      return options.withTransaction(async db => {
        const version = await readOwnedEditVersion(db, actor, parsed.subscriptionId, true);
        const row = await readEditEligibility(db, actor, parsed.subscriptionId);
        assertBinding(row);
        const now = options.now(), expires = new Date(Date.parse(now) + 15 * 60_000).toISOString();
        const eligibility = editPreviewEligibility(row, parsed.subscriptionId, parsed.action, now);
        if (!eligibility.preview.canApply) return eligibility;
        assertEditVersion(parsed.expectedTemplateVersion, version);
        const baseline = await readCompleteEditBaseline(db, parsed.subscriptionId);
        const context = await editContext(db,actor,parsed.subscriptionId,isSizedOptIn(parsed),await phase(db,actor,parsed.subscriptionId));
        const request = normalizeSizedEdit(parsed, context, policy);
        const preview = editPreviewEligibility(row, parsed.subscriptionId, request.action, now);
        const priced = await quote(db, context, request, "preview", baseline, row), { subscriptionId: _id, ...raw } = request;
        const catalogAdmission = await readEditCatalogEvidence(db, options.readCatalogAdmission, {
          subscriptionId: request.subscriptionId, lane: ["add_addon", "remove_addon", "update_addon_quantity"].includes(request.action) ? "exact" : "sized",
          cadenceDays: priced.cadenceDays, lines: priced.lines,
        });
        await db.query("SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::integer,$7::timestamptz,$8::jsonb,$9::jsonb,$10::jsonb,$11::timestamptz)",
          [actor.actorId, actor.clientId, request.subscriptionId, request.action, priced.quoteHash, priced.expectedTemplateVersion, expires, raw,
            { editConsent: priced.editConsent, consentRequest: consentRequest(parsed), catalogAdmission, lines: priced.lines, cadenceDays: priced.cadenceDays,
              compositionConstraint: priced.compositionConstraint, subjectFacts: { ...priced.subjectFacts, catalogFacts: priced.catalogFacts }, optInFacts: priced.optInFacts },
            { currentRecurringPrice: priced.currentRecurringPrice, newRecurringPrice: priced.newRecurringPrice, delta: priced.delta }, options.now()]);
        return { ...preview, editConsent: priced.editConsent, quoteHash: priced.quoteHash, quoteExpiresAt: expires, currentTotal: priced.currentRecurringPrice,
          newTotal: priced.newRecurringPrice, delta: priced.delta, packageEdit: { currentRecurringPrice: priced.currentRecurringPrice,
            newRecurringPrice: priced.newRecurringPrice, delta: priced.delta, quoteHash: priced.quoteHash,
            effectiveCycleAt: preview.preview.nextCycleAt, priceAgreementPolicy: "lock_until_edit" } };
      });
    },
    async apply(actor: PackageEditActor, key: string, input: SizedEditRequest): Promise<SizedEditApplyResult> {
      const parsed = parse(input);
      if (key !== key.trim() || key.length < 8 || key.length > 180) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await readOwnedEditVersion(db, actor, parsed.subscriptionId, false);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actor.actorId, key]);
        const stored = await replay(db, actor, key, parsed);
        if (stored) return stored;
        assertRequestLimits(parsed);
        const version = await readOwnedEditVersion(db,actor,parsed.subscriptionId,true);
        const row = await readEditEligibility(db, actor, parsed.subscriptionId);
        assertBinding(row);
        assertFreshEditEligible(row, options.now());
        assertEditVersion(parsed.expectedTemplateVersion,version);
        const numberedPhase = await phase(db,actor,parsed.subscriptionId);
        const action = numberedPhase.phase === "graduation_pending" && canNormalizeToResize(parsed.action) ? "resize_bundle" : parsed.action;
        await db.query("SELECT subscription_id FROM public.subscription_renewal_terms WHERE subscription_id=$1::uuid FOR UPDATE", [parsed.subscriptionId]);
        await takeEditConsent(db, actor, parsed.subscriptionId, action, parsed.acceptedQuoteHash, version, key, options.now(), consentRequest(parsed));
        const baseline = await readCompleteEditBaseline(db, parsed.subscriptionId);
        const context = await editContext(db,actor,parsed.subscriptionId,isSizedOptIn(parsed),numberedPhase);
        const request = normalizeSizedEdit(parsed, context, policy), priced = await quote(db, context, request, "apply", baseline, row);
        if (request.acceptedQuoteHash !== priced.quoteHash) throw new Error("subscription_reprice_quote_not_accepted");
        const addon = ["add_addon", "remove_addon", "update_addon_quantity"].includes(request.action);
        if (!addon) await options.assertCurrentFacts(db, context, priced.subjectFacts, priced.optInFacts, priced.catalogFacts);
        const { subscriptionId: _id, ...raw } = request, { subscriptionId: _submittedId, ...submitted } = parsed;
        const payload = { ...raw, request: raw, lines: priced.lines, cadenceDays: priced.cadenceDays, compositionConstraint: priced.compositionConstraint,
          subjectFacts: { ...priced.subjectFacts, catalogFacts: priced.catalogFacts }, optInFacts: priced.optInFacts, expectedTemplateVersion: priced.expectedTemplateVersion };
        const { rows } = await (addon ? db.query("SELECT public.subscription_line_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS result",
          [actor.actorId, actor.clientId, key, request.subscriptionId, request.action, payload, options.now()])
          : db.query("SELECT public.subscription_consented_bundle_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::timestamptz,'sized',$7::jsonb) AS result",
            [actor.actorId, actor.clientId, key, request.subscriptionId, payload, options.now(), submitted]));
        return decodeEditResult(rows, "result", request.subscriptionId, request.action);
      });
    },
  };
}
type SizedEditor = ReturnType<typeof createPostgresSizedEditor>;
/** Binding dispatch does not read sized context for lifecycle or ordinary classic operations. */
export function createOfferDispatchedSubscriptionEditor(input: {
  readBinding(actor: PackageEditActor, id: string): Promise<"classic" | "sized.v1" | null>;
  classic: { preview(actor: PackageEditActor, request: never): Promise<unknown>; apply(actor: PackageEditActor, key: string, request: never): Promise<unknown> };
  sized: Omit<SizedEditor, "replayCompleted"> & Partial<Pick<SizedEditor, "replayCompleted">>;
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
      const previous = await input.sized.replayCompleted?.(actor, key, request);
      if (previous) return previous;
      const editor = await choose(actor, request); return editor.apply(actor, key, request as never);
    },
  };
}
export function mapSizedEditError(error: unknown, phase: "preview" | "apply", action?: string) {
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
  if (/subscription_(?:edit_invalid_intro_fixed|edit_invalid_graduation_addon|edit_cycle_history_unreadable|configured_offer_immutable)/u.test(message)) {
    return { status: 409 as const, code: "CONFLICT" as const, message: "Customer subscription action is not allowed", reason: message };
  }
  if (["subscription_edit_invalid_agreed_price", "subscription_edit_invalid_intro_marker"].includes(message)) {
    return mapPackageEditError(new Error(message === "subscription_edit_invalid_agreed_price" ? "subscription_reprice_sized_agreed_price_unreadable" : "subscription_reprice_sized_marker_unreadable"), phase, action);
  }
  return mapPackageEditError(error, phase, action);
}
