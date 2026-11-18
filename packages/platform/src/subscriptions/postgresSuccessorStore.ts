import { z } from "zod";
import { subscriptionRecord, type NativeRenewalCodec, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { applyNativeRenewalMoney } from "./postgresRenewalSettlement.js";
import { requireHistoricalProtocolBinding, type HistoricalSuccessorProtocolBinding } from "./successorProtocolBindings.js";
import type { RenewalFrozenSnapshot } from "./contracts/renewal.js";
import type { PackageEditActor, PackageEditLimits } from "./packageEditContracts.js";
import type { SizedEditPolicy } from "./contracts/sizedEdit.js";
import type { SuccessorCaseKind, SuccessorResolutionRequest } from "./contracts/successors.js";
import { isSizedOptIn, parseSuccessorSizedEditRequest, readSizedConsentPhase, readSizedEditContext } from "./sizedEditContext.js";
import type { SizedHostPorts } from "./sizedEditPorts.js";
import { assertSizedSubjectFacts } from "./sizedEditQuote.js";
import { buildEditConsent, hashEditConsent } from "./editConsent.js";
import { readCompleteEditBaseline } from "./editConsentBaseline.js";

const rowId = z.guid(), timestamp = z.iso.datetime({ offset: true });
const nonblank = z.string().refine(value => value.trim().length > 0);
const quantity = z.number().int().nonnegative(), cycleNumber = quantity.positive();
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);

/** Internal native wait observation wire. @experimental */
export const nativeWaitDeficitSchema = z.looseObject({
  sku: nonblank, requiredUnits: cycleNumber, reservedUnits: quantity, availableUnits: quantity, missingUnits: quantity,
});
const waitCase = z.looseObject({
  id: rowId, client_id: rowId, subscription_id: rowId, fingerprint, identity_key: nonblank,
  scheduled_at: timestamp, cycle_number: cycleNumber, state: z.enum(["waiting", "stock_secured", "resumed", "closed"]),
  deficits: z.array(nativeWaitDeficitSchema),
  cycle_id: rowId.nullable(), order_id: rowId.nullable(), fulfillment_id: rowId.nullable(),
  opened_at: timestamp, last_checked_at: timestamp, last_selected_at: timestamp.nullable(),
  stock_secured_at: timestamp.nullable(), resumed_at: timestamp.nullable(), closed_at: timestamp.nullable(),
  block_reason: z.string().nullable(), waitingNoticeRelevant: z.boolean().optional(),
});
const version = { schemaVersion: z.literal(2) };
/** Internal versioned case wire. @experimental */
export const successorCaseReadSchema = z.discriminatedUnion("caseKind", [
  z.looseObject({ ...version, caseKind: z.literal("legacy"), case: waitCase.extend({ renewal_operation_id: rowId }) }),
  z.looseObject({ ...version, caseKind: z.literal("successor"), case: waitCase.extend({ operation_id: rowId }),
    waitingNoticeRelevant: z.boolean().optional() }),
]);

const frozen = z.looseObject({ operationId: rowId, identityKey: nonblank, operationFingerprint: fingerprint,
  snapshot: z.looseObject({ subscriptionId: rowId, scheduledAt: timestamp }) });
/** Internal due-candidate wire. @experimental */
const successorDueListSchema = z.array(z.discriminatedUnion("operationKind", [
  z.looseObject({ ...version, operationKind: z.literal("legacy"), due: z.looseObject({
    subscription_id: rowId, client_id: rowId, scheduled_at: timestamp, cycle_number: cycleNumber, cadence_days: cycleNumber,
    currency_code: z.string().regex(/^[A-Z]{3}$/u), stock_source_key: nonblank, settlement_channel_key: nonblank,
    authorization_ref: nonblank, payer_account_ref: nonblank.nullable(), unattended_charge_authorized_at: timestamp,
    delivery_admission: nonblank, delivery_block_reason: z.string().nullable(),
  }) }),
  frozen.extend({ ...version, operationKind: z.literal("successor") }),
]));

const legacyCandidate = frozen.extend({
  caseId: rowId.nullable(), cycleNumber,
  binding: z.looseObject({ caseId: rowId.nullable(), cycleId: rowId.nullable(), orderId: rowId.nullable(),
    paymentId: rowId.nullable(), engineIdempotencyKey: nonblank }),
}).refine(value => value.binding.caseId === value.caseId && value.binding.engineIdempotencyKey === value.identityKey);
const recoverySelection = z.looseObject({ caseKind: z.literal("successor"), caseId: rowId, operationId: rowId,
  rootOperationId: rowId, proposalId: rowId, claimGeneration: cycleNumber });

/** Internal frozen recovery selection wire. @experimental */
const successorCandidateListSchema = z.array(z.discriminatedUnion("operationKind", [
  z.looseObject({ ...version, operationKind: z.literal("legacy"), caseKind: z.literal("legacy"), frozen: legacyCandidate }),
  frozen.extend({
    ...version, operationKind: z.literal("successor"), caseKind: z.literal("successor"), caseId: rowId, cycleNumber,
    binding: recoverySelection,
  }).refine(value => value.binding.caseId === value.caseId && value.binding.operationId === value.operationId),
]));

const preparedSuccessor = z.looseObject({
  ...version, operationKind: z.literal("successor"), state: z.literal("attempt_prepared"),
  operationId: rowId, operationFingerprint: fingerprint, cycleId: rowId, orderId: rowId,
  settlementIntentId: rowId, replayed: z.boolean(),
});
const successorRecoveryResult = z.union([
  z.looseObject({ error: z.literal("stock_wait_check_failed"), caseId: rowId }),
  z.looseObject({ ...version, waiting: z.literal(true), caseKind: z.literal("successor"),
    caseId: rowId, deficits: z.array(nativeWaitDeficitSchema).min(1) }),
  z.looseObject({ ...version, operationKind: z.literal("successor"), waiting: z.literal(false), replayed: z.boolean(),
    caseId: rowId, operation: z.looseObject({ id: rowId }) }),
  z.looseObject({ ...version, operationKind: z.literal("successor"), waiting: z.literal(false), replayed: z.boolean(),
    reserved: z.literal(true), operationId: rowId, reservationId: rowId }),
]);

/** Internal schedule identity shared by successor reads and notices.
 * @experimental
 */
export function successorScheduleKey(subscriptionId: string, scheduledAt: string) {
  const fraction = /[.](\d+)/u.exec(scheduledAt)?.[1] ?? "";
  return `${subscriptionId}:${Date.parse(scheduledAt)}:${fraction.padEnd(6, "0").slice(3, 6)}`;
}

const successorCommandKey = z.string().trim().min(8).max(180);
const successorQuoteHash = z.string().trim().regex(/^[a-f0-9]{64}$/u);
const agreedMoney = z.object({ amountMinor: quantity, currency: z.string() });
const agreedLine = z.object({ variantId: rowId, qty: cycleNumber,
  quoteLine: z.object({ sku: nonblank, quantity: cycleNumber, unitPriceGross: agreedMoney, lineSubtotalGross: agreedMoney }) });
const classicQuoteLines = z.object({ baseLines: z.array(agreedLine), addonLines: z.array(agreedLine) });
const exactQuoteLines = z.object({ lines: z.array(agreedLine.extend({ isAddon: z.boolean() })) });
const subjectSnapshot = z.object({
  subjectFacts: z.object({
    subscriptionId: z.uuid(), clientId: z.uuid(), subjectRef: z.string().min(1),
    exclusions: z.custom<string[]>(), snapshot: z.record(z.string(), z.unknown()),
    catalogFacts: z.array(z.object({
      variantId: z.string(), sku: z.string(), groupId: z.string(), isAddon: z.boolean(), sellable: z.boolean(),
      physicalSize: z.number(), demandPerUnit: z.number(), documentRevisionId: z.string(), documentDigest: z.string(),
      verified: z.boolean(), exclusions: z.array(z.string()).nullable(), sellableNow: z.number().nullable(),
    })),
  }),
  optInFacts: z.record(z.string(), z.unknown()).nullable(),
});

function successorBusy(error:unknown,reason:"lc10_commerce_busy"|"lc10_root_operation_busy"="lc10_commerce_busy"):never {
  if((error as {code?:string}).code==="55P03")throw Object.assign(new Error(reason,{cause:error}),{code:"55P03"});throw error;
}

/** Internal source check shared by the existing preview owners. */
export async function lockUnpaidSuccessorPreview(db:SubscriptionQueryExecutor,actor:PackageEditActor,subscriptionId:string,source:{caseId:string;caseKind:SuccessorCaseKind}) {
  const id=z.uuid();id.parse(source.caseId);z.enum(["legacy","successor"]).parse(source.caseKind);
  const owned=(await db.query("SELECT s.id FROM public.subscriptions s JOIN public.clients c ON c.id=s.client_id WHERE s.id=$1::uuid AND c.id=$2::uuid AND c.principal_id=$3::uuid FOR UPDATE OF s NOWAIT",[subscriptionId,actor.clientId,actor.actorId]).catch(error=>successorBusy(error))).rows;
  if(owned.length!==1)throw new Error("subscription_command_forbidden");
  await db.query("SELECT id FROM public.clients WHERE id=$1::uuid FOR KEY SHARE NOWAIT",[actor.clientId]).catch(error=>successorBusy(error));
  const envelope=subscriptionRecord((await db.query("SELECT public.subscription_stock_wait_read_v2($1::uuid,$2::text) AS result",[source.caseId,source.caseKind])).rows[0]?.result);
  const row=subscriptionRecord(envelope.case);
  if(row.id!==source.caseId||row.subscription_id!==subscriptionId||row.client_id!==actor.clientId||!["waiting","stock_secured"].includes(String(row.state)))throw new Error("stock_wait_binding_changed");
  const value=source.caseKind==="legacy"
    ?(await db.query("SELECT public.subscription_stock_wait_frozen($1::uuid,$2::timestamptz) AS result",[subscriptionId,row.scheduled_at])).rows[0]?.result
    :(await db.query("SELECT public.subscription_stock_wait_frozen_v2($1::uuid) AS result",[row.operation_id])).rows[0]?.result;
  if(!value||subscriptionRecord(value).caseId!==source.caseId)throw new Error("stock_wait_successor_provider_owned");
  const table=source.caseKind==="legacy"?"subscription_renewal_operations":"subscription_successor_operations_v2";
  const operation=(await db.query(`SELECT state,terminal_reason FROM public.${table} WHERE id=$1::uuid`,[subscriptionRecord(value).operationId])).rows[0];
  if(!operation||!(operation.state==="refused"&&["inventory_unavailable","reservation_expired"].includes(String(operation.terminal_reason))||operation.state==="reserved"&&row.state==="stock_secured"))throw new Error("stock_wait_successor_not_stock_only");
}

/** Record a validated unpaid preview on its owner connection after locking the subscription.
 * @experimental
 */
export async function recordUnpaidSuccessorPreview(db: SubscriptionQueryExecutor, input: {
  actor: PackageEditActor; subscriptionId: string; action: string; quoteHash: string; templateVersion: number;
  expiresAt: string; request: unknown; snapshot: unknown; totals: unknown; now: string;
}) {
  const at = Date.parse(input.now), expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(at)) throw Object.assign(new Error("subscription_command_invalid_input"), { code: "22023" });
  if (!Number.isFinite(expires) || expires <= at) {
    throw Object.assign(new Error("subscription_edit_quote_expired"), { code: "22023" });
  }
  await db.query(`WITH doomed AS (
    SELECT id FROM public.subscription_quote_previews WHERE status='previewed' AND expires_at<$1::timestamptz-interval '7 days'
    ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.subscription_quote_previews q USING doomed WHERE q.id=doomed.id`, [input.now]);
  const { rows } = await db.query(`INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,
    template_version,expires_at,request_payload,quote_snapshot,totals,created_at,updated_at)
    SELECT s.id,s.client_id,$3::uuid,$4::text,$5::text,s.template_version,$7::timestamptz,
      $8::jsonb,$9::jsonb,$10::jsonb,$11::timestamptz,$11::timestamptz
    FROM public.subscriptions s WHERE s.id=$1::uuid AND s.client_id=$2::uuid AND s.template_version=$6::integer
    ON CONFLICT (subscription_id,client_id,action,quote_hash,template_version) WHERE status='previewed' DO UPDATE SET
      actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,request_payload=EXCLUDED.request_payload,
      quote_snapshot=EXCLUDED.quote_snapshot,totals=EXCLUDED.totals,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at
    RETURNING id`, [input.subscriptionId, input.actor.clientId, input.actor.actorId, input.action, input.quoteHash, input.templateVersion,
    input.expiresAt, input.request, input.snapshot, input.totals, input.now]);
  if (rows.length !== 1) throw new Error("subscription_edit_stale_template");
  return z.uuid().parse(rows[0]?.id);
}

/** Server-owned enrichment of a recorded native preview. The store preholds the
 * subscription, client, preview and source parents. Enrichment may update only
 * that preview; it takes no catalogue fence or other commerce lock.
 * @experimental
 */
export interface SuccessorPreviewBinding {
  prepare(db: SubscriptionQueryExecutor, input: { previewId: string; subscriptionId: string; actor: PackageEditActor }): Promise<{
    applyPayload: Record<string, unknown>; cycleSnapshot: RenewalFrozenSnapshot | null;
  }>;
}
/** @experimental */
export interface SuccessorOfferInput {
  proposalId: string; subscriptionId: string; predecessorSkuId: string; successorSkuId: string; publicationId: string; previewId: string;
  lane: "classic" | "exact" | "sized" | "legacy"; action: string;
  sourceBinding: { kind: "ordinary_edit" } | { kind: "stock_wait"; caseKind: SuccessorCaseKind; caseId: string };
  historicalBinding?: Omit<HistoricalSuccessorProtocolBinding, "authorityRef">;
  now: string;
}
/** Explicit native stores only. Construction mounts no consumer, payment rail or capability.
 * @experimental
 */
export function createPostgresSuccessorStore(options: {
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  codec: NativeRenewalCodec;
  previews: SuccessorPreviewBinding;
  historicalBindings?: readonly HistoricalSuccessorProtocolBinding[];
  /** The same host assertion used by the ordinary sized editor. Required for fresh sized acceptance.
   * @experimental
   */
  assertCurrentSizedFacts?: SizedHostPorts["assertCurrentFacts"];
  /** Host edit limits for fresh stock-wait acceptance.
   * @experimental
   */
  editLimits?: { package: PackageEditLimits;
    sized: Pick<SizedEditPolicy, "maximumCoreLines" | "maximumAddonLines" | "maximumQuantity" | "allowedCadences"> };
  /** Select the most recent active and healthy saved method, then the most recent active method,
   * then the most recent method. Compare last update first and creation time second.
   * Read the owned subscription's payment data without changing it. Keep missing method
   * references and buyer fields nullable.
   * @experimental
   */
  selectSavedMethod?(db: SubscriptionQueryExecutor, input: { subscriptionId: string; clientId: string; asOf: string }): Promise<{
    methodRef: string | null; buyer: { email: string | null; firstName: string | null; lastName: string | null };
  }>;
}) {
  const id=z.uuid(),stamp=z.iso.datetime(),hash=z.string().regex(/^[a-f0-9]{64}$/u);
  const call=async(db:SubscriptionQueryExecutor,name:string,args:unknown[])=>subscriptionRecord((await db.query(`SELECT public.${name}(${args.map((_,index)=>`$${index+1}`).join(",")}) AS result`,args)).rows[0]?.result);
  async function read(db: SubscriptionQueryExecutor, sql: string, args: unknown[]) {
    const { rows } = await db.query(sql, args);
    if (rows.length !== 1 || rows[0]?.result === undefined) throw new Error("subscription_renewal_response_invalid");
    return rows[0].result;
  }
  async function authorize(db:SubscriptionQueryExecutor,actor:PackageEditActor,subscriptionId:string) {
    const row=(await db.query(`SELECT EXISTS(SELECT 1 FROM public.clients c JOIN public.subscriptions s ON s.client_id=c.id
      WHERE c.id=$1::uuid AND c.principal_id=$2::uuid AND s.id=$3::uuid) AS allowed`,[id.parse(actor.clientId),id.parse(actor.actorId),id.parse(subscriptionId)])).rows[0];
    if(row?.allowed!==true) throw new Error("subscription_command_forbidden");
  }
  async function authorizeProposal(db:SubscriptionQueryExecutor,actor:PackageEditActor,proposalId:string) {
    const row=(await db.query("SELECT subscription_id,client_id,preview,lane,source_binding FROM public.subscription_successor_proposals WHERE id=$1::uuid",[id.parse(proposalId)])).rows[0];
    if(!row||row.client_id!==actor.clientId||subscriptionRecord(row.preview).actor_id!==actor.actorId) throw new Error("subscription_command_forbidden");
    await authorize(db,actor,String(row.subscription_id));
    return row;
  }
  async function withSavedMethod<T extends Record<string, unknown>>(db: SubscriptionQueryExecutor, result: T, snapshot: unknown, asOf: string) {
    if (!options.selectSavedMethod) return result;
    const { subscriptionId, clientId } = subscriptionRecord(snapshot);
    return { ...result, paymentSelection: await options.selectSavedMethod(db, {
      subscriptionId: id.parse(subscriptionId), clientId: id.parse(clientId), asOf,
    }) };
  }
  function withCandidateSavedMethod(db: SubscriptionQueryExecutor, row: z.output<typeof successorCandidateListSchema>[number], now: string) {
    return withSavedMethod(db, row, row.operationKind === "legacy" ? row.frozen.snapshot : row.snapshot, now);
  }
  async function assertRetainedAcceptance(db: SubscriptionQueryExecutor, actor: PackageEditActor,
    proposal: Awaited<ReturnType<typeof authorizeProposal>>, input: {
      proposalId: string; commandKey: string; quoteHash: string | null; now: string; caseId?: string;
    }) {
    if (proposal.lane === "legacy" || input.quoteHash === null) return;
    // Take the same prefix as the SQL primitives. Exact receipt replay never rereads host facts.
    const { actorId, clientId } = actor;
    const args = [actorId, input.commandKey];
    const tryLock = async (sql: string, parameters: unknown[], message = "lc10_commerce_busy") => {
      if ((await db.query(sql, parameters)).rows[0]?.allowed !== true) {
        throw Object.assign(new Error(message), { code: "55P03" });
      }
    };
    await tryLock("SELECT pg_try_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0)) AS allowed", args);
    const receipt = await db.query("SELECT 1 FROM public.subscription_command_receipts WHERE actor_id=$1::uuid AND idempotency_key=$2::text", args);
    if (receipt.rows.length > 0) return;
    await tryLock(`SELECT pg_try_advisory_xact_lock(hashtextextended($1::uuid::text||':successor-edit:'||
      encode(sha256(convert_to($1::uuid::text||':'||$2::text,'UTF8')),'hex'),0)) AS allowed`, args);
    const source = subscriptionRecord(proposal.source_binding);
    if (source.kind === "stock_wait") {
      if (input.caseId && source.caseId !== input.caseId) return;
      if ((await db.query("SELECT current_setting('transaction_isolation') AS isolation")).rows[0]?.isolation !== "read committed") {
        throw Object.assign(new Error("inventory_admission_isolation_unsupported"), { code: "22023" });
      }
      await tryLock("SELECT pg_try_advisory_xact_lock(846832106,1) AS allowed", [], "inventory_admission_busy");
    } else if (input.caseId) return;
    const subscriptionId = String(proposal.subscription_id);
    await db.query("SELECT id FROM public.subscriptions WHERE id=$1::uuid AND client_id=$2::uuid FOR UPDATE NOWAIT",
      [subscriptionId, clientId]).catch(error => successorBusy(error));
    await db.query("SELECT id FROM public.clients WHERE id=$1::uuid FOR KEY SHARE NOWAIT", [clientId]).catch(error => successorBusy(error));
    await authorize(db, actor, subscriptionId);
    await db.query("SELECT id FROM public.subscription_successor_proposals WHERE id=$1::uuid FOR UPDATE NOWAIT",
      [input.proposalId]).catch(error => successorBusy(error));
    const quote = (await db.query(`SELECT q.request_payload, q.quote_snapshot, q.action, q.quote_hash, p.request->'applyPayload' AS apply_payload
      FROM public.subscription_successor_proposals p JOIN public.subscriptions s ON s.id=p.subscription_id
      JOIN public.subscription_quote_previews q ON q.id=(p.preview->>'id')::uuid
      WHERE p.id=$1::uuid AND p.state='offered' AND p.quote_hash=$2::text AND p.expires_at>$3::timestamptz
        AND p.template_version=s.template_version AND q.status='previewed' AND to_jsonb(q)=p.preview
      FOR UPDATE OF q NOWAIT`, [input.proposalId, input.quoteHash, input.now]).catch(error => successorBusy(error))).rows[0];
    // The SQL primitive supplies its existing refusal for a stale or mismatched proposal.
    if (!quote) return;
    const evidence = subscriptionRecord(quote.quote_snapshot);
    const retained = subscriptionRecord(evidence.editConsent);
    let lines;
    if (proposal.lane === "classic") {
      const parsed = classicQuoteLines.safeParse(evidence);
      if (!parsed.success) throw new Error("subscription_edit_quote_drift");
      lines = [...parsed.data.baseLines.map(line => ({ ...line, isAddon: false })),
        ...parsed.data.addonLines.map(line => ({ ...line, isAddon: true }))];
    } else {
      const parsed = exactQuoteLines.safeParse(evidence);
      if (!parsed.success) throw new Error("subscription_edit_quote_drift");
      lines = parsed.data.lines;
    }
    const baseline = await readCompleteEditBaseline(db, subscriptionId);
    const current = buildEditConsent(baseline, String(retained.innerQuoteHash), lines);
    if (hashEditConsent(current) !== quote.quote_hash || (await db.query("SELECT $1::jsonb=$2::jsonb AS matching", [current, retained])).rows[0]?.matching !== true) {
      throw new Error("subscription_edit_quote_drift");
    }
    const request = subscriptionRecord(quote.request_payload);
    if (proposal.lane === "sized") parseSuccessorSizedEditRequest(request, { subscriptionId, applyPayload: quote.apply_payload });
    if (source.kind === "stock_wait") {
      const limits = options.editLimits;
      if (!limits) throw new Error("dependency_unavailable");
      const sized = proposal.lane === "sized";
      const bounds = sized ? limits.sized : limits.package;
      const coreLimit = sized ? limits.sized.maximumCoreLines : limits.package.maximumBaseLines;
      const cadence = proposal.lane === "classic" ? request.planDays : evidence.cadenceDays;
      const validCadence = typeof cadence === "number" && Number.isSafeInteger(cadence) && cadence > 0
        && (sized ? limits.sized.allowedCadences.includes(cadence) : cadence <= limits.package.maximumPlanDays);
      const nominalPlan = request.nominalPlanDays ?? request.planDays;
      const coreCount = lines.filter(line => !line.isAddon).length;
      if (!validCadence || (!sized && typeof nominalPlan === "number" && nominalPlan > limits.package.maximumPlanDays)
        || coreCount < 1 || coreCount > coreLimit || lines.length - coreCount > bounds.maximumAddonLines
        || lines.some(line => line.qty > bounds.maximumQuantity)) throw new Error("subscription_reprice_invalid_request");
    }
    if (proposal.lane !== "sized") return;
    if (!options.assertCurrentSizedFacts) throw new Error("subscription_reprice_sized_subject_facts_unreadable");
    const snapshot = subjectSnapshot.safeParse(quote.quote_snapshot);
    if (!snapshot.success) throw new Error("subscription_reprice_sized_subject_facts_unreadable");
    const { catalogFacts, ...facts } = snapshot.data.subjectFacts;
    assertSizedSubjectFacts(facts, { clientId, subscriptionId }, { maximumExclusions: 20 });
    const numberedPhase = await readSizedConsentPhase(db, clientId, subscriptionId);
    const context = await readSizedEditContext(db, clientId, subscriptionId, isSizedOptIn({
      action: String(quote.action), resizeLever: request.resizeLever,
    }));
    await options.assertCurrentSizedFacts(db, { ...context, numberedPhase }, facts, snapshot.data.optInFacts, catalogFacts);
  }
  return {
    offer(actor:PackageEditActor,input:SuccessorOfferInput) {
      id.parse(input.proposalId);id.parse(input.subscriptionId);id.parse(input.predecessorSkuId);id.parse(input.successorSkuId);id.parse(input.publicationId);id.parse(input.previewId);stamp.parse(input.now);
      const historicalBinding=input.historicalBinding ? requireHistoricalProtocolBinding(input.historicalBinding,options.historicalBindings??[]) : undefined;
      return options.withTransaction(async db=>{
        await authorize(db,actor,input.subscriptionId);
        const guard=(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('subscription-successor-proposal:'||$1::uuid::text,0)) AS allowed",[input.proposalId])).rows[0];
        if(guard?.allowed!==true)throw Object.assign(new Error("lc10_commerce_busy"),{code:"55P03"});
        await db.query("SELECT id FROM public.subscriptions WHERE id=$1::uuid AND client_id=$2::uuid FOR UPDATE NOWAIT",[input.subscriptionId,actor.clientId]).catch(error=>successorBusy(error));
        await db.query("SELECT id FROM public.clients WHERE id=$1::uuid FOR KEY SHARE NOWAIT",[actor.clientId]).catch(error=>successorBusy(error));
        const { subscriptionId, now, historicalBinding: _historical, ...request } = input;
        const authored = { ...request, ...(historicalBinding ? { historicalBinding } : {}) };
        const prior = (await db.query(`SELECT p.subscription_id,p.client_id,p.preview->>'actor_id' AS actor_id,
          p.request-ARRAY['applyPayload','cycleSnapshot']=$2::jsonb AS matching,
          p.request
          FROM public.subscription_successor_proposals p WHERE p.id=$1::uuid FOR UPDATE NOWAIT`,
        [input.proposalId, authored]).catch(error => successorBusy(error))).rows[0];
        if (prior) {
          if (prior.client_id !== actor.clientId || prior.actor_id !== actor.actorId) throw new Error("subscription_command_forbidden");
          if (prior.subscription_id !== subscriptionId || prior.matching !== true) {
            throw Object.assign(new Error("subscription_command_idempotency_conflict"), { code: "23505" });
          }
          return call(db, "subscription_successor_proposal_offer_v2", [subscriptionId, actor.clientId, prior.request, now]);
        }
        const preview=(await db.query("SELECT actor_id,client_id,subscription_id FROM public.subscription_quote_previews WHERE id=$1::uuid FOR UPDATE NOWAIT",[input.previewId]).catch(error=>successorBusy(error))).rows[0];
        if(!preview||preview.actor_id!==actor.actorId||preview.client_id!==actor.clientId||preview.subscription_id!==input.subscriptionId) throw new Error("subscription_command_forbidden");
        if(input.sourceBinding.kind==="stock_wait"){
          const source=input.sourceBinding;
          const query=source.caseKind==="legacy"
            ?"SELECT renewal_operation_id AS root,id AS original_case FROM public.subscription_stock_wait_cases WHERE id=$1::uuid AND subscription_id=$2::uuid AND client_id=$3::uuid"
            :"SELECT g.root_operation_id AS root,c.root_case_id AS original_case FROM public.subscription_successor_wait_cases_v2 c JOIN public.subscription_successor_operations_v2 g ON g.id=c.operation_id WHERE c.id=$1::uuid AND c.subscription_id=$2::uuid AND c.client_id=$3::uuid";
          const parent=(await db.query(query,[id.parse(source.caseId),input.subscriptionId,actor.clientId])).rows[0];
          if(!parent)throw new Error("stock_wait_binding_changed");
          await db.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1::uuid FOR UPDATE NOWAIT",[parent.root]).catch(error=>successorBusy(error,"lc10_root_operation_busy"));
          await db.query("SELECT id FROM public.subscription_stock_wait_cases WHERE id=$1::uuid FOR UPDATE NOWAIT",[parent.original_case]).catch(error=>successorBusy(error));
        }
        const native=await options.previews.prepare(db,{ previewId:input.previewId,subscriptionId:input.subscriptionId,actor });
        if (input.lane === "sized") parseSuccessorSizedEditRequest(native.applyPayload.request, {
          subscriptionId, applyPayload: native.applyPayload,
        });
        if(input.sourceBinding.kind==="stock_wait"&&!native.cycleSnapshot) throw new Error("dependency_unavailable");
        return call(db,"subscription_successor_proposal_offer_v2",[subscriptionId,actor.clientId,{ ...authored,applyPayload:native.applyPayload,
          ...(native.cycleSnapshot?{ cycleSnapshot:options.codec.encode(native.cycleSnapshot) }:{}) },now]);
      });
    },
    decide(actor:PackageEditActor,input:{ proposalId:string;decision:"accepted"|"declined"|"expired";commandKey:string;quoteHash:string|null;now:string }) {
      stamp.parse(input.now);
      const commandKey = successorCommandKey.parse(input.commandKey);
      const quoteHash = successorQuoteHash.nullable().parse(input.quoteHash);
      return options.withTransaction(async db => {
        const proposal = await authorizeProposal(db, actor, input.proposalId);
        if (input.decision === "accepted") await assertRetainedAcceptance(db, actor, proposal, { ...input, commandKey, quoteHash });
        return call(db, "subscription_successor_proposal_decide_v2", [input.proposalId, actor.clientId, input.decision, commandKey, quoteHash, input.now]);
      });
    },
    resolve(actor:PackageEditActor,input:Omit<SuccessorResolutionRequest,"clientId">) {
      const commandKey = successorCommandKey.parse(input.commandKey);
      const acceptedQuoteHash = successorQuoteHash.parse(input.acceptedQuoteHash);
      stamp.parse(input.now);id.parse(input.caseId);
      return options.withTransaction(async db => {
        const proposal = await authorizeProposal(db, actor, input.proposalId);
        await assertRetainedAcceptance(db, actor, proposal, { ...input, commandKey, quoteHash: acceptedQuoteHash });
        return call(db, "resolve_stock_wait_with_successor", [input.caseId, input.proposalId, acceptedQuoteHash, commandKey, actor.clientId, input.now]);
      });
    },
    async readCase(caseId:string,caseKind:SuccessorCaseKind) {
      return options.withTransaction(async db => {
        const value = await read(db, "SELECT public.subscription_stock_wait_read_v2($1::uuid,$2::text) AS result", [id.parse(caseId), caseKind]);
        if (value === null) return null;
        const parsed = successorCaseReadSchema.safeParse(value);
        if (!parsed.success || parsed.data.caseKind !== caseKind || parsed.data.case.id !== caseId.toLowerCase()) {
          throw new Error("subscription_renewal_response_invalid");
        }
        return subscriptionRecord(value);
      });
    },
    listDue(limit:number|null,now:string) {
      return options.withTransaction(async db => {
        const cap = Math.max(1, Math.min(limit ?? 50, 50)), args = [cap, stamp.parse(now)];
        const due = successorDueListSchema.safeParse(await read(db,
          "SELECT public.subscription_list_due_successor_renewals_v2($1::integer,$2::timestamptz) AS result", args));
        if (!due.success) throw new Error("subscription_renewal_response_invalid");
        const waiting = successorCandidateListSchema.safeParse(await read(db,
          "SELECT public.subscription_stock_wait_candidates_v2($1::integer,$2::timestamptz) AS result", args));
        if (!waiting.success) throw new Error("subscription_renewal_response_invalid");
        const waitKey = (row: z.output<typeof successorCandidateListSchema>[number]) => {
          const snapshot = row.operationKind === "legacy" ? row.frozen.snapshot : row.snapshot;
          return successorScheduleKey(snapshot.subscriptionId, snapshot.scheduledAt);
        };
        const recovery = new Map(waiting.data.map(row => [waitKey(row), row]));
        const selected: unknown[] = [], seen = new Set<string>();
        const add = async (key: string, row: unknown) => {
          if (selected.length >= cap || seen.has(key)) return;
          seen.add(key);
          const wait = recovery.get(key);
          selected.push(wait ? await withCandidateSavedMethod(db, wait, now) : row);
        };
        for (let index = 0; index < Math.max(due.data.length, waiting.data.length) && selected.length < cap; index++) {
          const normal = due.data[index], wait = waiting.data[index];
          if (normal) {
            const key = normal.operationKind === "legacy"
              ? successorScheduleKey(normal.due.subscription_id, normal.due.scheduled_at)
              : successorScheduleKey(normal.snapshot.subscriptionId, normal.snapshot.scheduledAt);
            await add(key, normal);
          }
          if (wait) await add(waitKey(wait), wait);
        }
        return selected;
      });
    },
    listCandidates(limit:number|null,now:string) {
      return options.withTransaction(async db => {
        const value = await read(db, "SELECT public.subscription_stock_wait_candidates_v2($1::integer,$2::timestamptz) AS result", [limit, stamp.parse(now)]);
        const parsed = successorCandidateListSchema.safeParse(value);
        if (!parsed.success) throw new Error("subscription_renewal_response_invalid");
        if (!options.selectSavedMethod) return value;
        const result = [];
        for (const row of parsed.data) {
          result.push(await withCandidateSavedMethod(db, row, now));
        }
        return result;
      });
    },
    claim(input:{ identityKey:string;fingerprint:string;snapshot:Record<string,unknown>;workerId:string;leaseSeconds?:number;now:string }) {
      const snapshot=options.codec.decode(input.snapshot);hash.parse(input.fingerprint);
      if(options.codec.fingerprint(snapshot)!==input.fingerprint)throw new Error("subscription_renewal_snapshot_fingerprint_mismatch");
      return options.withTransaction(db=>call(db,"subscription_claim_successor_renewal_v2",[input.identityKey,input.fingerprint,options.codec.encode(snapshot),input.workerId,input.leaseSeconds??300,stamp.parse(input.now)]));
    },
    reserve(input:{ operationId:string;claimToken:string;holdSeconds?:number;now:string }) { return options.withTransaction(db=>call(db,"fulfillment_reserve_successor_renewal_v2",[id.parse(input.operationId),id.parse(input.claimToken),input.holdSeconds??900,stamp.parse(input.now)])); },
    recover(input:{ operationId:string;fingerprint:string;workerId:string;now:string;
      /** @experimental */
      selection?:z.input<typeof recoverySelection>;
    }) {
      const operationId=id.parse(input.operationId),fingerprint=hash.parse(input.fingerprint),now=stamp.parse(input.now);
      const selection=input.selection===undefined?undefined:recoverySelection.parse(input.selection);
      return options.withTransaction(async db=>{
        const rows=selection?(await db.query(`SELECT public.subscription_stock_wait_admit_v2(jsonb_build_object(
          'operationId',g.id,'operationFingerprint',$2::text,'identityKey',g.identity_key,
          'snapshot',g.cycle_snapshot,'claimToken',g.claim_token,'worker',$3::text),
          jsonb_build_object('stockWaitRecovery',$4::jsonb),$5::timestamptz) AS result
          FROM public.subscription_successor_operations_v2 g WHERE g.id=$1::uuid`,
        [operationId,fingerprint,input.workerId,selection,now])).rows
          :(await db.query("SELECT public.subscription_stock_wait_recover_refusal_v2($1,$2,$3,$4) AS result",
            [operationId,fingerprint,input.workerId,now])).rows;
        if(rows.length!==1)throw Object.assign(new Error("stock_wait_frozen_binding_changed"),{code:"23505"});
        if(!successorRecoveryResult.safeParse(rows[0]?.result).success)throw new Error("subscription_renewal_response_invalid");
        return subscriptionRecord(rows[0]?.result);
      });
    },
    prepare(input:{ operationId:string;claimToken:string;now:string }) {
      return options.withTransaction(async db=>{
        const wire=(await db.query("SELECT cycle_snapshot FROM public.subscription_successor_operations_v2 WHERE id=$1::uuid",[id.parse(input.operationId)])).rows[0]?.cycle_snapshot;
        const snapshot=options.codec.decode(subscriptionRecord(wire));
        const result=await call(db,"commerce_prepare_successor_renewal_v2",[input.operationId,id.parse(input.claimToken),stamp.parse(input.now)]);
        const prepared=preparedSuccessor.safeParse(result);
        if(!prepared.success||prepared.data.operationId!==input.operationId.toLowerCase())throw new Error("subscription_renewal_prepare_response_invalid");
        if(result.replayed!==true)await applyNativeRenewalMoney(db,snapshot,result.orderId);
        return withSavedMethod(db, result, snapshot, input.now);
      });
    },
    settle(input:{ operationId:string;eventKey:string;evidence:{ operationFingerprint:string;outcome:"succeeded"|"refused";externalRef:string;reason?:string };now:string }) {
      hash.parse(input.evidence.operationFingerprint);
      return options.withTransaction(db=>call(db,"commerce_settle_successor_renewal_v2",[id.parse(input.operationId),input.eventKey,input.evidence,stamp.parse(input.now)]));
    },
    markResumed(orderId:string) {
      return options.withTransaction(async db => {
        const value = await read(db, "SELECT public.subscription_stock_wait_mark_resumed_v2($1::uuid) AS result", [id.parse(orderId)]);
        if (value === null) return null;
        const parsed = successorCaseReadSchema.safeParse(value);
        if (!parsed.success || parsed.data.caseKind !== "successor" || parsed.data.case.state !== "resumed"
          || parsed.data.case.order_id !== orderId.toLowerCase()) throw new Error("subscription_renewal_response_invalid");
        return subscriptionRecord(value);
      });
    },
  };
}
