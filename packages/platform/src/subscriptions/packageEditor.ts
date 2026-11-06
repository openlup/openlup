import { z } from "zod";
import { createClassicPackageRepricer } from "./classicPackageQuote.js";
import { createPostgresPackageEditReadPort } from "./packageEditRead.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import type { PackageEditActor, PackageEditApplyResult, PackageEditBlockedReason, PackageEditPreview,
  PackageEditQuote, PackageEditRequest, PackageEditorOptions } from "./packageEditContracts.js";

const stamp = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : String(value);
const resultSchema = z.object({ status: z.enum(["applied", "replayed", "noop"]), subscriptionId: z.string(),
  action: z.literal("update_package_template"), subscriptionStatus: z.string(), nextCycleAt: z.string().nullable(),
  templateVersion: z.number().int(), eventId: z.string().nullable(), originalStatus: z.enum(["applied", "noop"]).optional() });
/** Host authentication supplies actor/client; only the desired set and acceptance are customer input.
 * SQL owns the final locked guard, one-use ledger acceptance and future-template transaction. */
export function createPostgresPackageEditor(options: PackageEditorOptions) {
  const limits = options.limits;
  if ([limits.maximumPlanDays, limits.maximumBaseLines, limits.maximumAddonLines, limits.maximumQuantity].some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("subscription_reprice_limits_unavailable");
  const line = z.object({ variantId: z.uuid(), qty: z.number().int().positive().max(limits.maximumQuantity) }).strict();
  const schema = z.object({ subscriptionId: z.uuid(), planDays: z.number().int().positive().max(limits.maximumPlanDays),
    base: z.array(line).min(1).max(limits.maximumBaseLines), addons: z.array(line).max(limits.maximumAddonLines).default([]),
    expectedTemplateVersion: z.number().int().positive().optional(), acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict();
  const parse = (input: PackageEditRequest) => { const result = schema.safeParse(input);
    if (!result.success) throw new Error("subscription_reprice_invalid_request"); return result.data; };
  async function owned(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string) {
    const row = (await db.query(`SELECT s.*,EXISTS(SELECT 1 FROM public.subscription_dunning_cases d
      WHERE d.subscription_id=s.id AND d.status='open') AS payment_blocked,
      EXISTS(SELECT 1 FROM public.subscription_cycles c LEFT JOIN public.commerce_orders o ON o.subscription_cycle_id=c.id
       WHERE c.subscription_id=s.id AND c.scheduled_at=s.next_cycle_at AND
        (c.status IN ('payment_pending','paid') OR o.status IN ('paid','fulfillment_pending','fulfilled'))) AS cycle_locked,
      EXISTS(SELECT 1 FROM public.subscription_method_states m WHERE m.subscription_id=s.id AND m.health_state='healthy') AS method_healthy
      FROM public.subscriptions s WHERE s.id=$1::uuid AND s.client_id=$2::uuid`, [id, actor.clientId])).rows[0];
    if (!row) throw new Error("subscription_command_forbidden"); return row;
  }
  async function replay(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string, key: string, payload: Record<string, unknown>): Promise<PackageEditApplyResult | null> {
    const prior = (await db.query(`SELECT r.*,r.command=jsonb_build_object('clientId',$1::uuid,'subscriptionId',$2::uuid,
      'action','update_package_template','payload',$4::jsonb) AND r.quote_hash IS NOT DISTINCT FROM ($4::jsonb->>'acceptedQuoteHash') AS matches
      FROM public.subscription_command_receipts r WHERE r.actor_id=$3::uuid AND r.idempotency_key=$5::text`,
    [actor.clientId, id, actor.actorId, payload, key])).rows[0];
    if (!prior) return null;
    if (!prior.matches) throw new Error("subscription_command_idempotency_conflict");
    if (prior.status === "refused") throw new Error(String(subscriptionRecord(prior.result).reason));
    if (prior.status !== "applied" && prior.status !== "noop") throw new Error("subscription_command_idempotency_conflict");
    return resultSchema.parse({ ...subscriptionRecord(prior.result), status: "replayed", originalStatus: prior.status });
  }
  const repricer = (db: SubscriptionQueryExecutor) => createClassicPackageRepricer({ ...options, readPort: createPostgresPackageEditReadPort(db) });
  function evidence(request: ReturnType<typeof parse>, quote: PackageEditQuote) {
    return { planDays: quote.cadenceDays, nominalPlanDays: request.planDays, base: request.base, addons: request.addons,
      baseLines: quote.baseLines, addonLines: quote.addonLines, compositionConstraint: quote.compositionConstraint,
      currentRecurringPrice: quote.currentRecurringPrice, newRecurringPrice: quote.newRecurringPrice, delta: quote.delta,
      expectedTemplateVersion: quote.expectedTemplateVersion, acceptedQuoteHash: request.acceptedQuoteHash };
  }
  return {
    async preview(actor: PackageEditActor, input: PackageEditRequest): Promise<PackageEditPreview> {
      const request = parse(input);
      if (request.acceptedQuoteHash !== undefined) throw new Error("subscription_reprice_invalid_request");
      return options.withTransaction(async db => {
        const row = await owned(db, actor, request.subscriptionId), next = stamp(row.next_cycle_at);
        const now = options.now(), expires = new Date(Date.parse(now) + 15 * 60_000).toISOString();
        const cutoff = next ? new Date(Date.parse(next) - Number(row.edit_window_hours) * 3_600_000).toISOString() : null;
        // The shared blocker wins before ordinary edit eligibility; cycle lock precedes method/cutoff.
        const reason: PackageEditBlockedReason | null = row.payment_blocked ? "payment_blocked" : row.status !== "active" ? "not_active"
          : row.cycle_locked ? "cycle_locked" : !row.method_healthy ? "missing_payment_method"
            : cutoff && Date.parse(cutoff) <= Date.parse(now) ? "edit_window_closed" : null;
        const preview: PackageEditPreview = {
          preview: { subscriptionId: request.subscriptionId, action: "update_package_template", canApply: reason === null,
            blockedReason: reason, nextCycleAt: next, editCutoffAt: cutoff, templateVersion: Number(row.template_version) },
          lockedCycle: { locked: reason === "cycle_locked" || reason === "payment_blocked",
            status: reason === "cycle_locked" ? "blocked_preflight" : reason === "payment_blocked" ? "dunning" : null },
          futureTemplate: { templateVersion: Number(row.template_version), effectiveCycleAt: next, priceAgreementPolicy: "lock_until_edit" },
        };
        if (reason) return preview;
        const quote = await repricer(db).quote(request), payload = evidence(request, quote);
        const { subscriptionId: _subscriptionId, ...originalRequest } = request;
        await db.query("SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,'update_package_template',$4::text,$5::integer,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb,$10::timestamptz)",
          [actor.actorId, actor.clientId, request.subscriptionId, quote.quoteHash, quote.expectedTemplateVersion, expires,
            { ...originalRequest, planDays: payload.planDays, nominalPlanDays: payload.nominalPlanDays },
            { baseLines: payload.baseLines, addonLines: payload.addonLines, compositionConstraint: payload.compositionConstraint },
            { currentRecurringPrice: quote.currentRecurringPrice, newRecurringPrice: quote.newRecurringPrice, delta: quote.delta }, options.now()]);
        return { ...preview, quoteHash: quote.quoteHash, quoteExpiresAt: expires, currentTotal: quote.currentRecurringPrice,
          newTotal: quote.newRecurringPrice, delta: quote.delta, packageEdit: { currentRecurringPrice: quote.currentRecurringPrice,
            newRecurringPrice: quote.newRecurringPrice, delta: quote.delta, quoteHash: quote.quoteHash,
            effectiveCycleAt: next, priceAgreementPolicy: "lock_until_edit" } };
      });
    },
    async apply(actor: PackageEditActor, idempotencyKey: string, input: PackageEditRequest): Promise<PackageEditApplyResult> {
      const request = parse(input), { subscriptionId, ...raw } = request;
      if (idempotencyKey !== idempotencyKey.trim() || idempotencyKey.length < 8 || idempotencyKey.length > 180) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actor.actorId, idempotencyKey]);
        await owned(db, actor, subscriptionId);
        const stored = await replay(db, actor, subscriptionId, idempotencyKey, raw);
        if (stored) return stored;
        const quote = await repricer(db).quote(request);
        if (request.acceptedQuoteHash !== quote.quoteHash) throw new Error("subscription_reprice_quote_not_accepted");
        const value = subscriptionRecord((await db.query("SELECT public.subscription_package_edit_apply($1::uuid,$2::uuid,$3::text,$4::uuid,$5::jsonb,$6::timestamptz) AS response",
          [actor.actorId, actor.clientId, idempotencyKey, subscriptionId, { request: raw, ...evidence(request, quote) }, options.now()])).rows[0]?.response);
        if (value.status === "refused") throw new Error(String(value.reason));
        return resultSchema.parse(value);
      });
    },
  };
}
