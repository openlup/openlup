import { z } from "zod";
import { buildEditConsent, consentRequest, hashEditConsent, readEditCatalogEvidence, takeEditConsent } from "./editConsent.js";
import { exactMinor, readCompleteEditBaseline, safeMinor } from "./editConsentBaseline.js";
import type { PackageEditActor, ReadSubscriptionEditCatalogAdmission } from "./packageEditContracts.js";
import { assertEditVersion, assertFreshEditEligible, editPreviewEligibility, readEditEligibility, readOwnedEditVersion } from "./packageEditRead.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

import type { LegacyEditConsentRequest } from "./contracts/editConsent.js";

const legacyPreview = z.object({ subscriptionId: z.uuid(), action: z.literal("update_bundle"), canApply: z.boolean(),
  templateVersion: z.number().int().positive() });
const legacyApplied = z.object({ subscriptionId: z.uuid(), action: z.literal("update_bundle"), status: z.enum(["applied", "replayed"]),
  eventId: z.uuid(), templateVersion: z.number().int().positive(), nextCycleAt: z.string().nullable(), subscriptionStatus: z.string().min(1) });

/** One authenticated native connection owns both quote ledgers and the original legacy transaction.
 * RPC-only composition cannot provide this boundary.
 * @experimental
 */
export function createPostgresLegacyEditConsentBridge(options: {
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  now(): string;
  /** @experimental */
  readCatalogAdmission?: ReadSubscriptionEditCatalogAdmission;
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
    const { rows } = await db.query(`SELECT auth.uid()=$1::uuid AND EXISTS(SELECT 1 FROM public.clients c JOIN public.subscriptions s ON s.client_id=c.id
      WHERE c.id=$2::uuid AND c.principal_id=$1::uuid AND s.id=$3::uuid) AS allowed`, [actor.actorId,actor.clientId,id]);
    if (rows.length !== 1 || rows[0].allowed !== true) throw new Error("subscription_command_forbidden");
  }
  async function legacy(db: SubscriptionQueryExecutor, request: Request, key: string, hash?: string) {
    const values = [request.subscriptionId,key,...(hash === undefined ? [] : [hash]),JSON.stringify(request.coreLines),JSON.stringify(request.addonLines),request.compositionConstraint,
      request.cadenceDays ?? null,request.expectedTemplateVersion ?? null];
    const { rows } = await db.query(`SELECT public.customer_subscription_${hash === undefined ? "preview" : "apply"}_bundle_as_actor(${values.map((_,index) => `$${index + 1}`).join(",")}) AS result`, values);
    const result = subscriptionRecord(rows[0]?.result);
    const parsed = hash === undefined ? legacyPreview.safeParse(result.preview) : legacyApplied.safeParse(result.subscriptionAction);
    if (rows.length !== 1 || !parsed.success || parsed.data.subscriptionId !== request.subscriptionId.toLowerCase()) throw new Error("subscription_edit_quote_drift");
    return result;
  }
  async function lockedQuote(db: SubscriptionQueryExecutor, actor: PackageEditActor, request: Request, key: string) {
    const row = (await db.query(`WITH derived AS (SELECT 'command:'||encode(sha256(convert_to($2::uuid::text||':'||$3::text,'UTF8')),'hex') AS key)
      SELECT q.*, q.idempotency_key=derived.key AS derived,
        q.command_key_identity=jsonb_build_object('derivation','principal-sha256.v1','actorId',$2::uuid) AS matches
      FROM public.subscription_edit_quotes q CROSS JOIN derived WHERE q.subscription_id=$1::uuid
        AND (q.idempotency_key=derived.key OR (q.idempotency_key=$3::text AND q.command_key_identity IS NULL))
      ORDER BY (q.idempotency_key=derived.key) DESC LIMIT 1 FOR UPDATE OF q`, [request.subscriptionId,actor.actorId,key])).rows[0];
    if (!row) throw new Error("subscription_edit_quote_required");
    if (row.derived === true && row.matches !== true) throw new Error("subscription_command_ambiguous_idempotency_key");
    return row;
  }
  async function disclosure(db: SubscriptionQueryExecutor, request: Request, quote: Record<string, unknown>) {
    const code = "agreement_baseline_unavailable";
    const baseline = await readCompleteEditBaseline(db, request.subscriptionId);
    const parsed = z.array(z.object({ variantId: z.uuid(), isAddon: z.boolean(), quantity: z.unknown(), unitPriceMinor: z.unknown(), currency: z.unknown() }))
      .min(1).safeParse(quote.proposed_lines);
    if (!parsed.success) throw new Error(code);
    const proposed = parsed.data, variants = new Set(proposed.map(line => line.variantId));
    if (variants.size !== proposed.length) throw new Error(code);
    const identities = (await db.query("SELECT id,sku FROM public.catalog_skus WHERE id=ANY($1::uuid[])", [[...variants]])).rows;
    const skuById = new Map(identities.map(row => [row.id, row.sku]));
    if (identities.length !== variants.size || skuById.size !== variants.size) throw new Error(code);
    if (typeof quote.currency_code !== "string" || !/^[A-Z]{3}$/u.test(quote.currency_code)) throw new Error("agreement_currency_unavailable");
    const currency = quote.currency_code;
    const consent = buildEditConsent(baseline, String(quote.quote_hash), proposed.map(line => {
      const sku = skuById.get(line.variantId);
      if (typeof sku !== "string" || !sku) throw new Error(code);
      if (typeof line.currency !== "string" || !/^[A-Z]{3}$/u.test(line.currency)) throw new Error("agreement_currency_unavailable");
      if (line.currency !== currency) throw new Error("agreement_currency_mismatch");
      const quantity = exactMinor(line.quantity, code, true), amountMinor = exactMinor(line.unitPriceMinor, code);
      return { variantId: line.variantId, qty: quantity, isAddon: line.isAddon,
        quoteLine: { sku, quantity, unitPriceGross: { amountMinor,currency }, lineSubtotalGross: { amountMinor: safeMinor(BigInt(quantity) * BigInt(amountMinor), code),currency } } };
    }));
    if (consent.newTotalMinor !== exactMinor(quote.new_total_minor, "subscription_edit_quote_drift")) throw new Error("subscription_edit_quote_drift");
    return { consent, quote, hash: hashEditConsent(consent) };
  }
  return {
    async preview(actor: PackageEditActor, key: string, input: LegacyEditConsentRequest) {
      const request = parse(input,key);
      if (request.acceptedQuoteHash !== undefined) throw new Error("subscription_command_invalid_input");
      return options.withTransaction(async db => {
        await authorize(db,actor,request.subscriptionId);
        const version = await readOwnedEditVersion(db, actor, request.subscriptionId, true);
        const row = await readEditEligibility(db, actor, request.subscriptionId);
        const eligibility = editPreviewEligibility(row, request.subscriptionId, "update_bundle", options.now());
        if (!eligibility.preview.canApply) return { preview: eligibility.preview };
        assertEditVersion(request.expectedTemplateVersion, version);
        const catalogAdmission = await readEditCatalogEvidence(db, options.readCatalogAdmission, {
          subscriptionId: request.subscriptionId, lane: "legacy", cadenceDays: request.cadenceDays ?? Number(row.cadence_days),
          lines: [...request.coreLines.map(line => ({ ...line, isAddon: false })), ...request.addonLines.map(line => ({ ...line, isAddon: true }))],
        });
        const pricedRequest = catalogAdmission ? { ...request, compositionConstraint: { ...request.compositionConstraint, catalogAdmission } } : request;
        const result = await legacy(db,pricedRequest,key), preview = subscriptionRecord(result.preview);
        if (preview.canApply !== true) return result;
        const selected = await lockedQuote(db, actor, request, key);
        const { consent,quote,hash } = await disclosure(db,request,selected);
        const { subscriptionId: _id,...raw } = request;
        await db.query("SELECT public.subscription_quote_preview_record($1::uuid,$2::uuid,$3::uuid,'update_bundle',$4::text,$5::integer,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb,$10::timestamptz)",
          [actor.actorId,actor.clientId,request.subscriptionId,hash,quote.expected_template_version,quote.expires_at,raw,
            { editConsent: consent, consentRequest: consentRequest(request), catalogAdmission, legacyQuoteId: quote.id, legacyQuoteHash: quote.quote_hash },{},options.now()]);
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
        const version = await readOwnedEditVersion(db, actor, request.subscriptionId, true);
        const historical = (await db.query(`SELECT 1 FROM public.subscription_events WHERE subscription_id=$1::uuid AND
          (idempotency_key='command:'||encode(sha256(convert_to($2::uuid::text||':'||$3::text,'UTF8')),'hex') OR
            (idempotency_key=$3::text AND (starts_with(event_type,'subscription.customer_self_service.')
              OR COALESCE(payload->'commandKeyIdentity',payload#>'{payload,commandKeyIdentity}') IS NOT NULL))) LIMIT 1`, [request.subscriptionId,actor.actorId,key])).rows[0];
        if (historical) return legacy(db,request,key,request.acceptedQuoteHash);
        assertFreshEditEligible(await readEditEligibility(db, actor, request.subscriptionId), options.now());
        assertEditVersion(request.expectedTemplateVersion, version);
        const inner = await lockedQuote(db,actor,request,key);
        const selected = await takeEditConsent(db,actor,request.subscriptionId,"update_bundle",request.acceptedQuoteHash,version,key,options.now(),consentRequest(request));
        const snapshot = subscriptionRecord(selected.quote_snapshot), current = await disclosure(db,request,inner);
        if (snapshot.legacyQuoteId !== inner.id || snapshot.legacyQuoteHash !== inner.quote_hash || current.hash !== request.acceptedQuoteHash) throw new Error("subscription_edit_quote_drift");
        const pricedRequest = snapshot.catalogAdmission
          ? { ...request, compositionConstraint: { ...request.compositionConstraint, catalogAdmission: snapshot.catalogAdmission } } : request;
        const result = await legacy(db,pricedRequest,key,String(inner.quote_hash)), eventId = subscriptionRecord(result.subscriptionAction).eventId;
        await db.query("SELECT public.subscription_quote_preview_mark_accepted($1::uuid,$2::text,$3::uuid,$4::timestamptz)", [selected.id,key,eventId,options.now()]);
        await db.query(`INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
          VALUES($1::uuid,$2::text,$3::uuid,$4::uuid,encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex'),$5::jsonb,$6::text,$7::jsonb,'applied')`,
          [actor.actorId,key,request.subscriptionId,actor.clientId,command,request.acceptedQuoteHash,result]);
        return result;
      });
    },
  };
}
