import { z } from "zod";
import { agreedEditTotal, assertEditIntent, assertRecurringEditQuote, buildEditConsent, consentRequest, decodeEditResult, hashEditConsent, isEditContentNoop, readEditCatalogEvidence, readEditReceipt, takeEditConsent } from "./editConsent.js";
import { readCompleteEditBaseline } from "./editConsentBaseline.js";
import { lockUnpaidSuccessorPreview, recordUnpaidSuccessorPreview } from "./postgresSuccessorStore.js";
import type { SuccessorCaseKind } from "./contracts/successors.js";
import { createExactSubscriptionRepricer } from "./exactEditQuote.js";
import type { ClassicBundleEditRequest } from "./contracts/editConsent.js";
import type { ExactSubscriptionEditAction, ExactSubscriptionEditQuote, ExactSubscriptionEditRequest, SubscriptionEditRequest } from "./contracts/exactEdit.js";
import { createClassicEditRepricer, quoteClassicBundle } from "./classicPackageQuote.js";
import { assertEditVersion, assertFreshEditEligible, createPostgresPackageEditReadPort, editPreviewEligibility, readEditEligibility, readOwnedEditVersion } from "./packageEditRead.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import type { PackageEditActor, PackageEditApplyResult, PackageEditPreview,
  PackageEditQuote, PackageEditRequest, PackageEditorOptions } from "./packageEditContracts.js";

type EditAction = "update_package_template" | ExactSubscriptionEditAction;
/** Host authentication supplies actor/client; only the desired set and acceptance are customer input.
 * SQL owns the final locked guard, one-use ledger acceptance and future-template transaction. */
export function createPostgresPackageEditor(options: PackageEditorOptions) {
  const limits = options.limits;
  if ([limits.maximumPlanDays, limits.maximumBaseLines, limits.maximumAddonLines, limits.maximumQuantity].some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("subscription_reprice_limits_unavailable");
  const line = z.object({ variantId: z.uuid(), qty: z.number().int().positive() }).strict();
  const schema = z.object({ subscriptionId: z.uuid(), planDays: z.number().int().positive(),
    base: z.array(line).min(1), addons: z.array(line).default([]),
    expectedTemplateVersion: z.number().int().positive().optional(), acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict();
  const acceptance = { subscriptionId: z.uuid(), expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() };
  const exactSchema = z.discriminatedUnion("action", [
    z.object({ ...acceptance, action: z.literal("swap_base_line"), fromVariantId: z.uuid(), toVariantId: z.uuid() }).strict(),
    z.object({ ...acceptance, action: z.literal("add_addon"), variantId: z.uuid(), qty: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("update_addon_quantity"), variantId: z.uuid(), qty: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("remove_addon"), variantId: z.uuid() }).strict(),
    z.object({ ...acceptance, action: z.literal("update_plan_length"), planDays: z.number().int().positive() }).strict(),
    z.object({ ...acceptance, action: z.literal("update_base_mix"), base: z.array(line).min(1) }).strict(),
    z.object({ ...acceptance, action: z.literal("update_portion"), portionMode: z.string().min(1) }).strict(),
  ]);
  const parse = (input: SubscriptionEditRequest) => { const result = z.union([schema, exactSchema]).safeParse(input);
    if (!result.success) throw new Error("subscription_reprice_invalid_request"); return result.data; };
  function assertRequestLimits(request: ReturnType<typeof parse>) {
    const base = "base" in request ? request.base : [], addons = "addons" in request ? request.addons : [];
    if (("planDays" in request && request.planDays > limits.maximumPlanDays) || base.length > limits.maximumBaseLines ||
      addons.length > limits.maximumAddonLines || [...base, ...addons].some(line => line.qty > limits.maximumQuantity) ||
      ("qty" in request && request.qty > limits.maximumQuantity)) throw new Error("subscription_reprice_invalid_request");
  }
  const exactRepricer = (db: SubscriptionQueryExecutor, quotePort: PackageEditorOptions["quotePort"]) => createExactSubscriptionRepricer({ ...options, quotePort, readPort: createPostgresPackageEditReadPort(db) });
  async function quoteFor(db: SubscriptionQueryExecutor, request: ReturnType<typeof parse>, current: Record<string, unknown>) {
    const baseline = await readCompleteEditBaseline(db, request.subscriptionId);
    if ("action" in request) assertEditIntent(baseline, request);
    if (typeof options.quotePort?.createServerAuthoritativeQuote !== "function") throw new Error("subscription_preview_reprice_unavailable");
    const quotePort: PackageEditorOptions["quotePort"] = { async createServerAuthoritativeQuote(input) {
      const result = await options.quotePort.createServerAuthoritativeQuote(input);
      if (!result?.quote) throw new Error("subscription_preview_reprice_unavailable");
      assertRecurringEditQuote(baseline.currency, input.lines, result.quote); return result;
    } };
    const quote = await ("action" in request ? exactRepricer(db, quotePort).quote(request)
      : createClassicEditRepricer({ ...options, quotePort, readPort: createPostgresPackageEditReadPort(db) }, agreedEditTotal(baseline)).quote(request));
    if (!quote) return null;
    const desired = "lines" in quote ? quote.lines : [...quote.baseLines.map(line => ({ ...line, isAddon: false })),
      ...quote.addonLines.map(line => ({ ...line, isAddon: true }))];
    const keepAgreement = isEditContentNoop({ lane: "action" in request ? "exact" : "classic", action: "action" in request ? request.action : "update_package_template",
      request, baseline, desired, current, cadenceDays: quote.cadenceDays, constraint: quote.compositionConstraint, fullMode: options.portionModes?.full });
    const editConsent = buildEditConsent(baseline, quote.quoteHash, desired, keepAgreement);
    const currentRecurringPrice = { amountMinor: editConsent.agreedTotalMinor, currency: editConsent.currency };
    return { ...quote, editConsent, quoteHash: hashEditConsent(editConsent), currentRecurringPrice,
      newRecurringPrice: { amountMinor: editConsent.newTotalMinor, currency: editConsent.currency },
      delta: { amountMinor: editConsent.subtotalDeltaMinor, currency: editConsent.currency } };
  }
  function evidence(request: ReturnType<typeof parse>, quote: PackageEditQuote | ExactSubscriptionEditQuote) {
    if ("lines" in quote) return quote;
    if ("action" in request) throw new Error("subscription_reprice_invalid_request");
    return { planDays: quote.cadenceDays, nominalPlanDays: request.planDays, base: request.base, addons: request.addons,
      baseLines: quote.baseLines, addonLines: quote.addonLines, compositionConstraint: quote.compositionConstraint,
      currentRecurringPrice: quote.currentRecurringPrice, newRecurringPrice: quote.newRecurringPrice, delta: quote.delta,
      expectedTemplateVersion: quote.expectedTemplateVersion, acceptedQuoteHash: request.acceptedQuoteHash };
  }
  const editor = {
    async preview(actor: PackageEditActor, input: SubscriptionEditRequest, stockWait?:{caseId:string;caseKind:SuccessorCaseKind}): Promise<PackageEditPreview<EditAction>&{previewId?:string}> {
      const request = parse(input), action: EditAction = "action" in request ? request.action : "update_package_template";
      assertRequestLimits(request);
      if (request.acceptedQuoteHash !== undefined) throw new Error("subscription_reprice_invalid_request");
      return options.withTransaction(async db => {
        if (stockWait) {
          const initial = editPreviewEligibility(await readEditEligibility(db, actor, request.subscriptionId), request.subscriptionId, action, options.now());
          if (!initial.preview.canApply && initial.preview.blockedReason !== "edit_window_closed") return initial;
          await lockUnpaidSuccessorPreview(db, actor, request.subscriptionId, stockWait);
        }
        const version = await readOwnedEditVersion(db, actor, request.subscriptionId, !stockWait);
        const row = await readEditEligibility(db, actor, request.subscriptionId);
        const now = options.now(), expires = new Date(Date.parse(now) + 15 * 60_000).toISOString();
        const preview = editPreviewEligibility(row, request.subscriptionId, action, now, Boolean(stockWait));
        const next = preview.preview.nextCycleAt;
        if (!preview.preview.canApply) return preview;
        assertEditVersion(request.expectedTemplateVersion, version);
        const quote = await quoteFor(db, request, row);
        if (!quote) throw new Error("subscription_preview_reprice_unavailable");
        const { subscriptionId: _subscriptionId, ...originalRequest } = request;
        const exact = "lines" in quote;
        const ledgerRequest = exact ? originalRequest : { ...originalRequest, planDays: quote.cadenceDays,
          nominalPlanDays: "planDays" in request ? request.planDays : undefined };
        const catalogAdmission = await readEditCatalogEvidence(db, options.readCatalogAdmission, {
          subscriptionId: request.subscriptionId, lane: exact ? "exact" : "classic", cadenceDays: quote.cadenceDays,
          lines: exact ? quote.lines : [...quote.baseLines.map(line => ({ ...line, isAddon: false })), ...quote.addonLines.map(line => ({ ...line, isAddon: true }))],
        });
        const binding = { editConsent: quote.editConsent, consentRequest: consentRequest(request), catalogAdmission };
        const snapshot = exact ? { ...binding, lines: quote.lines, cadenceDays: quote.cadenceDays, compositionConstraint: quote.compositionConstraint,
          ...(quote.portionModes ? { portionModes: quote.portionModes } : {}) }
          : { ...binding, baseLines: quote.baseLines, addonLines: quote.addonLines, compositionConstraint: quote.compositionConstraint };
        const totals = exact ? {} : { currentRecurringPrice: quote.currentRecurringPrice, newRecurringPrice: quote.newRecurringPrice, delta: quote.delta };
        const recordedAt = options.now();
        const previewId = stockWait ? await recordUnpaidSuccessorPreview(db, { actor, subscriptionId: request.subscriptionId, action,
          quoteHash: quote.quoteHash, templateVersion: quote.expectedTemplateVersion, expiresAt: expires,
          request: ledgerRequest, snapshot, totals, now: recordedAt }) : undefined;
        if (!stockWait) await db.query(`SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,'${action}',$4::text,$5::integer,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb,$10::timestamptz) AS result`,
          [actor.actorId, actor.clientId, request.subscriptionId, quote.quoteHash, quote.expectedTemplateVersion, expires, ledgerRequest, snapshot, totals, recordedAt]);
        const identity=stockWait?{previewId}:{};
        if (exact) return { ...preview,...identity, editConsent: quote.editConsent, currentTotal: quote.currentRecurringPrice, newTotal: quote.newRecurringPrice, delta: quote.delta, quoteHash: quote.quoteHash, quoteExpiresAt: expires };
        return { ...preview,...identity, editConsent: quote.editConsent, quoteHash: quote.quoteHash, quoteExpiresAt: expires, currentTotal: quote.currentRecurringPrice,
          newTotal: quote.newRecurringPrice, delta: quote.delta, packageEdit: { currentRecurringPrice: quote.currentRecurringPrice,
            newRecurringPrice: quote.newRecurringPrice, delta: quote.delta, quoteHash: quote.quoteHash,
            effectiveCycleAt: next, priceAgreementPolicy: "lock_until_edit" } };
      });
    },
    async apply(actor: PackageEditActor, idempotencyKey: string, input: SubscriptionEditRequest): Promise<PackageEditApplyResult<EditAction>> {
      const request = parse(input), { subscriptionId, ...raw } = request;
      const action: EditAction = "action" in request ? request.action : "update_package_template";
      if (idempotencyKey !== idempotencyKey.trim() || idempotencyKey.length < 8 || idempotencyKey.length > 180) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await readOwnedEditVersion(db, actor, subscriptionId, false);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actor.actorId, idempotencyKey]);
        const stored = await readEditReceipt(db, actor, subscriptionId, idempotencyKey, action, raw);
        if (stored) return decodeEditResult(stored.rows, "result", subscriptionId, action, stored.status);
        const version = await readOwnedEditVersion(db, actor, subscriptionId, true);
        assertRequestLimits(request);
        const row = await readEditEligibility(db, actor, subscriptionId);
        assertFreshEditEligible(row, options.now());
        assertEditVersion(request.expectedTemplateVersion, version);
        await db.query("SELECT subscription_id FROM public.subscription_renewal_terms WHERE subscription_id=$1::uuid FOR UPDATE", [subscriptionId]);
        await takeEditConsent(db, actor, subscriptionId, action, request.acceptedQuoteHash, version, idempotencyKey, options.now(), consentRequest(request));
        const quote = await quoteFor(db, request, row);
        if (quote && request.acceptedQuoteHash !== quote.quoteHash) throw new Error("subscription_reprice_quote_not_accepted");
        const enriched = { ...raw, request: raw, ...(quote ? evidence(request, quote) : {}) };
        const { rows } = await (action === "update_package_template"
          ? db.query("SELECT public.subscription_package_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::timestamptz) AS response",
            [actor.actorId, actor.clientId, idempotencyKey, subscriptionId, enriched, options.now()])
          : db.query("SELECT public.subscription_line_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::jsonb,$7::timestamptz) AS response",
            [actor.actorId, actor.clientId, idempotencyKey, subscriptionId, action, enriched, options.now()]));
        return decodeEditResult(rows, "response", subscriptionId, action);
      });
    },
  };
  // Overloads preserve the existing classic result types for classic callers.
  function preview(actor: PackageEditActor, input: PackageEditRequest): Promise<PackageEditPreview>;
  function preview(actor: PackageEditActor, input: ExactSubscriptionEditRequest): Promise<PackageEditPreview<ExactSubscriptionEditAction>>;
  function preview(actor: PackageEditActor, input: SubscriptionEditRequest): Promise<PackageEditPreview<EditAction>>;
  function preview(actor: PackageEditActor, input: SubscriptionEditRequest) { return editor.preview(actor, input); }
  function apply(actor: PackageEditActor, key: string, input: PackageEditRequest): Promise<PackageEditApplyResult>;
  function apply(actor: PackageEditActor, key: string, input: ExactSubscriptionEditRequest): Promise<PackageEditApplyResult<ExactSubscriptionEditAction>>;
  function apply(actor: PackageEditActor, key: string, input: SubscriptionEditRequest): Promise<PackageEditApplyResult<EditAction>>;
  function apply(actor: PackageEditActor, key: string, input: SubscriptionEditRequest) { return editor.apply(actor, key, input); }
  return { preview, apply,
    /** @experimental */
    previewStockWaitSuccessor(actor:PackageEditActor,input:SubscriptionEditRequest,source:{caseId:string;caseKind:SuccessorCaseKind}) {
      return editor.preview(actor,input,source);
    } };
}

/** Opt-in classic bundle and resize editor using host-owned composition rules.
 * The legacy bridge has its own command and quote ledger.
 * @experimental
 */
export function createPostgresClassicBundleEditor(options: PackageEditorOptions) {
  const uuid = z.uuid().transform(id => id.toLowerCase());
  const line = z.strictObject({ variantId: uuid, qty: z.number().int().positive() });
  const fields = { subscriptionId: uuid, cadenceDays: z.number().int().positive().optional(),
    compositionConstraint: z.record(z.string(), z.unknown()).optional(), expectedTemplateVersion: z.number().int().positive().optional(),
    acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() };
  const schema = z.discriminatedUnion("action", [
    z.strictObject({ ...fields, action: z.literal("update_bundle"), coreLines: z.array(line).min(1), addonLines: z.array(line).optional() }),
    z.strictObject({ ...fields, action: z.literal("resize_bundle"), resizeLever: z.strictObject({ kind: z.string().trim().min(1), value: z.unknown() }) }),
  ]);
  function parse(input: ClassicBundleEditRequest): ClassicBundleEditRequest {
    const result = schema.safeParse(input);
    if (!result.success) throw new Error("subscription_reprice_invalid_request");
    return result.data;
  }
  async function quote(db: SubscriptionQueryExecutor, request: ClassicBundleEditRequest, row: Record<string, unknown>, version: number) {
    if (row.configured_offer_version !== "classic") throw new Error("subscription_edit_invalid_offer_binding");
    const baseline = await readCompleteEditBaseline(db, request.subscriptionId);
    const priced = await quoteClassicBundle(options, request, baseline, { templateVersion: version, cadenceDays: Number(row.cadence_days),
      compositionConstraint: row.composition_constraint == null ? null : subscriptionRecord(row.composition_constraint) }, options.limits);
    const keep = isEditContentNoop({ lane: "sized", action: request.action, request, baseline, current: row, desired: priced.lines,
      cadenceDays: priced.cadenceDays, constraint: priced.compositionConstraint });
    const editConsent = buildEditConsent(baseline, priced.quoteHash, priced.lines, keep);
    return { ...priced, editConsent, quoteHash: hashEditConsent(editConsent), currentTotal: { amountMinor: editConsent.agreedTotalMinor, currency: editConsent.currency },
      newTotal: { amountMinor: editConsent.newTotalMinor, currency: editConsent.currency }, delta: { amountMinor: editConsent.subtotalDeltaMinor, currency: editConsent.currency } };
  }
  return {
    async preview(actor: PackageEditActor, input: ClassicBundleEditRequest): Promise<PackageEditPreview<ClassicBundleEditRequest["action"]>> {
      const request = parse(input), { subscriptionId, action, ...raw } = request;
      if (request.acceptedQuoteHash !== undefined) throw new Error("subscription_reprice_invalid_request");
      return options.withTransaction(async db => {
        const version = await readOwnedEditVersion(db, actor, subscriptionId, true);
        const row = await readEditEligibility(db, actor, subscriptionId);
        const now = options.now(), preview = editPreviewEligibility(row, subscriptionId, action, now);
        if (!preview.preview.canApply) return preview;
        assertEditVersion(request.expectedTemplateVersion, version);
        const priced = await quote(db, request, row, version);
        const catalogAdmission = await readEditCatalogEvidence(db, options.readCatalogAdmission, { subscriptionId, lane: "classic",
          cadenceDays: priced.cadenceDays, lines: priced.lines });
        const expires = new Date(Date.parse(now) + 15 * 60_000).toISOString();
        await db.query("SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::integer,$7::timestamptz,$8::jsonb,$9::jsonb,$10::jsonb,$11::timestamptz)",
          [actor.actorId, actor.clientId, subscriptionId, action, priced.quoteHash, version, expires, { ...raw, action },
            { editConsent: priced.editConsent, consentRequest: consentRequest(request), catalogAdmission, lines: priced.lines,
              cadenceDays: priced.cadenceDays, compositionConstraint: priced.compositionConstraint, subjectFacts: null, optInFacts: null },
            {}, now]);
        return { ...preview, editConsent: priced.editConsent, quoteHash: priced.quoteHash, quoteExpiresAt: expires,
          currentTotal: priced.currentTotal, newTotal: priced.newTotal, delta: priced.delta };
      });
    },
    async apply(actor: PackageEditActor, key: string, input: ClassicBundleEditRequest): Promise<PackageEditApplyResult<ClassicBundleEditRequest["action"]>> {
      const request = parse(input), { subscriptionId, ...submitted } = request;
      if (key !== key.trim() || key.length < 8 || key.length > 180) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await readOwnedEditVersion(db, actor, subscriptionId, false);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actor.actorId, key]);
        const stored = await readEditReceipt(db, actor, subscriptionId, key, request.action, submitted);
        if (stored) return decodeEditResult(stored.rows, "result", subscriptionId, request.action, stored.status);
        const version = await readOwnedEditVersion(db, actor, subscriptionId, true);
        const row = await readEditEligibility(db, actor, subscriptionId);
        const now = options.now();
        assertFreshEditEligible(row, now);
        assertEditVersion(request.expectedTemplateVersion, version);
        await db.query("SELECT subscription_id FROM public.subscription_renewal_terms WHERE subscription_id=$1::uuid FOR UPDATE", [subscriptionId]);
        await takeEditConsent(db, actor, subscriptionId, request.action, request.acceptedQuoteHash, version, key, now, consentRequest(request));
        const priced = await quote(db, request, row, version);
        if (priced.quoteHash !== request.acceptedQuoteHash) throw new Error("subscription_reprice_quote_not_accepted");
        const payload = { request: submitted, lines: priced.lines, cadenceDays: priced.cadenceDays, compositionConstraint: priced.compositionConstraint,
          expectedTemplateVersion: version, subjectFacts: null, optInFacts: null };
        const { rows } = await db.query("SELECT public.subscription_consented_bundle_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::timestamptz,'classic',$7::jsonb) AS result",
          [actor.actorId, actor.clientId, key, subscriptionId, payload, now, submitted]);
        return decodeEditResult(rows, "result", subscriptionId, request.action);
      });
    },
  };
}
