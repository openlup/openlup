import { z } from "zod";
import { buildEditConsent, hashEditConsent, takeEditConsent } from "./editConsent.js";
import { readCompleteEditBaseline } from "./editConsentBaseline.js";
import type { PackageEditActor } from "./packageEditContracts.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

import type { LegacyEditConsentRequest } from "./contracts/editConsent.js";

/** One authenticated native connection owns both quote ledgers and the original legacy transaction.
 * RPC-only composition cannot provide this boundary.
 * @experimental
 */
export function createPostgresLegacyEditConsentBridge(options: {
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  now(): string;
}) {
  if (typeof options.withTransaction !== "function") throw new Error("dependency_unavailable");
  const line = z.object({ variantId: z.uuid(), qty: z.number().int().positive() }).strict();
  const schema = z.object({ subscriptionId: z.uuid(), coreLines: z.array(line).min(1), addonLines: z.array(line).default([]),
    compositionConstraint: z.record(z.string(), z.unknown()).default({}), cadenceDays: z.number().int().positive().optional(),
    expectedTemplateVersion: z.number().int().positive().optional(), acceptedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict();
  type Request = z.infer<typeof schema>;
  function parse(input: LegacyEditConsentRequest, key: string): Request {
    const value = schema.safeParse(input);
    if (!value.success || key !== key.trim() || key.length < 8 || key.length > 180 || key.startsWith("command:")) throw new Error("subscription_command_invalid_input");
    return value.data;
  }
  async function authorize(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string) {
    const row = (await db.query(`SELECT auth.uid()=$1::uuid AND EXISTS(SELECT 1 FROM public.clients c JOIN public.subscriptions s ON s.client_id=c.id
      WHERE c.id=$2::uuid AND c.principal_id=$1::uuid AND s.id=$3::uuid) AS allowed`, [actor.actorId,actor.clientId,id])).rows[0];
    if (row?.allowed !== true) throw new Error("subscription_command_forbidden");
  }
  async function legacy(db: SubscriptionQueryExecutor, request: Request, key: string, hash?: string) {
    const values = [request.subscriptionId,key,...(hash === undefined ? [] : [hash]),JSON.stringify(request.coreLines),JSON.stringify(request.addonLines),request.compositionConstraint,
      request.cadenceDays ?? null,request.expectedTemplateVersion ?? null];
    return subscriptionRecord((await db.query(`SELECT public.customer_subscription_${hash === undefined ? "preview" : "apply"}_bundle_as_actor(${values.map((_,index) => `$${index + 1}`).join(",")}) AS result`, values)).rows[0]?.result);
  }
  async function lockedQuote(db: SubscriptionQueryExecutor, actor: PackageEditActor, request: Request, key: string) {
    const row = (await db.query(`SELECT * FROM public.subscription_edit_quotes WHERE subscription_id=$1::uuid AND
      idempotency_key='command:'||encode(sha256(convert_to($2::uuid::text||':'||$3::text,'UTF8')),'hex') FOR UPDATE`, [request.subscriptionId,actor.actorId,key])).rows[0];
    if (!row) throw new Error("subscription_edit_quote_required");
    return row;
  }
  async function disclosure(db: SubscriptionQueryExecutor, actor: PackageEditActor, request: Request, key: string) {
    const baseline = await readCompleteEditBaseline(db, request.subscriptionId), quote = await lockedQuote(db,actor,request,key);
    const proposed = quote.proposed_lines as Record<string, unknown>[];
    if (!Array.isArray(proposed)) throw new Error("agreement_baseline_unavailable");
    const identities = (await db.query("SELECT id,sku FROM public.catalog_skus WHERE id=ANY($1::uuid[])", [proposed.map(line => line.variantId)])).rows;
    const consent = buildEditConsent(baseline, String(quote.quote_hash), proposed.map(line => {
      const identity = identities.find(value => String(value.id) === line.variantId);
      if (!identity || typeof line.isAddon !== "boolean") throw new Error("agreement_baseline_unavailable");
      const quantity = Number(line.quantity), amountMinor = Number(line.unitPriceMinor), currency = String(quote.currency_code);
      return { variantId: String(line.variantId), qty: quantity, isAddon: line.isAddon,
        quoteLine: { sku: String(identity.sku), quantity, unitPriceGross: { amountMinor,currency }, lineSubtotalGross: { amountMinor: quantity * amountMinor,currency } } };
    }));
    return { consent, quote, hash: hashEditConsent(consent) };
  }
  return {
    async preview(actor: PackageEditActor, key: string, input: LegacyEditConsentRequest) {
      const request = parse(input,key);
      if (request.acceptedQuoteHash !== undefined) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await authorize(db,actor,request.subscriptionId);
        await db.query("SELECT id FROM public.subscriptions WHERE id=$1::uuid FOR UPDATE", [request.subscriptionId]);
        await readCompleteEditBaseline(db, request.subscriptionId);
        const result = await legacy(db,request,key), preview = subscriptionRecord(result.preview);
        if (preview.canApply !== true) return result;
        const { consent,quote,hash } = await disclosure(db,actor,request,key);
        const { subscriptionId: _id,...raw } = request;
        await db.query("SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,'update_bundle',$4::text,$5::integer,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb,$10::timestamptz)",
          [actor.actorId,actor.clientId,request.subscriptionId,hash,quote.expected_template_version,quote.expires_at,raw,
            { editConsent: consent, legacyQuoteId: quote.id, legacyQuoteHash: quote.quote_hash },{},options.now()]);
        return { ...result, preview: { ...preview,quoteHash: hash,editConsent: consent,
          currentTotal: { amountMinor: consent.agreedTotalMinor,currency: consent.currency },
          newTotal: { amountMinor: consent.newTotalMinor,currency: consent.currency },delta: { amountMinor: consent.subtotalDeltaMinor,currency: consent.currency } } };
      });
    },
    async apply(actor: PackageEditActor, key: string, input: LegacyEditConsentRequest) {
      const request = parse(input,key);
      if (!request.acceptedQuoteHash) throw new Error("subscription_edit_quote_required");
      return options.withTransaction(async db => {
        await authorize(db,actor,request.subscriptionId);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [actor.actorId,key]);
        const command = { clientId: actor.clientId,subscriptionId: request.subscriptionId,action: "update_bundle",payload: request };
        const stored = (await db.query(`SELECT r.*,r.command=$3::jsonb AND r.quote_hash=$4::text AS matches
          FROM public.subscription_command_receipts r WHERE actor_id=$1::uuid AND idempotency_key=$2::text`, [actor.actorId,key,command,request.acceptedQuoteHash])).rows[0];
        if (stored) {
          if (stored.matches !== true || stored.status !== "applied") throw new Error("subscription_command_idempotency_conflict");
          const result = subscriptionRecord(stored.result);
          return { ...result,subscriptionAction: { ...subscriptionRecord(result.subscriptionAction),status: "replayed" } };
        }
        const historical = (await db.query(`SELECT id FROM public.subscription_events WHERE subscription_id=$1::uuid AND
          (idempotency_key='command:'||encode(sha256(convert_to($2::uuid::text||':'||$3::text,'UTF8')),'hex') OR idempotency_key=$3::text)
          AND event_type='subscription.customer_self_service.update_bundle'`, [request.subscriptionId,actor.actorId,key])).rows[0];
        if (historical) return legacy(db,request,key,request.acceptedQuoteHash);
        const state = (await db.query("SELECT template_version FROM public.subscriptions WHERE id=$1::uuid FOR UPDATE", [request.subscriptionId])).rows[0];
        const inner = await lockedQuote(db,actor,request,key);
        const selected = await takeEditConsent(db,actor,request.subscriptionId,"update_bundle",request.acceptedQuoteHash,Number(state?.template_version),key,options.now());
        const snapshot = subscriptionRecord(selected.quote_snapshot), current = await disclosure(db,actor,request,key);
        if (snapshot.legacyQuoteId !== inner.id || snapshot.legacyQuoteHash !== inner.quote_hash || current.hash !== request.acceptedQuoteHash) throw new Error("subscription_edit_quote_drift");
        const result = await legacy(db,request,key,String(inner.quote_hash)), eventId = subscriptionRecord(result.subscriptionAction).eventId;
        await db.query("SELECT public.subscription_quote_preview_mark_accepted($1::uuid,$2::text,$3::uuid,$4::timestamptz)", [selected.id,key,eventId,options.now()]);
        await db.query(`INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
          VALUES($1::uuid,$2::text,$3::uuid,$4::uuid,encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex'),$5::jsonb,$6::text,$7::jsonb,'applied')`,
          [actor.actorId,key,request.subscriptionId,actor.clientId,command,request.acceptedQuoteHash,result]);
        return result;
      });
    },
  };
}
