import type { InvoiceFacts, InvoiceIdentity, InvoiceStorePort, InvoiceHostPorts, InvoiceProviderPort } from "./contracts/index.js";
import { claimInvoiceSellerRevision } from "./sellerRevision.js";
import { createNativeUnsupportedInvoicePorts } from "./nativeUnsupported.js";

type InvoiceClaim = Parameters<InvoiceStorePort["preflight"]>[0]["claim"];
type NativeStore = InvoiceStorePort & {
  /** Read-only discovery before a host can install facts. Replays may repeat targets. */
  discoverDuties(limit: number, afterDutyId?: string | null): Promise<readonly { readonly dutyId: string; readonly orderId: string }[]>;
};
type DeliveryClaim = Exclude<Awaited<ReturnType<InvoiceStorePort["claimDeliveries"]>>, { kind: "unsupported" }>[number];
type DeliveryProjection = {
  /** Host-owned M04 keys, presentation and recipient resolution, after leasing.
   * Return only the envelope for this document; a failed projection never sends.
   */
  projectDelivery(input: { readonly deliveryRef: string; readonly documentId: string; readonly channel: string; readonly recipientRef: string; readonly attemptCount: number }): Promise<Pick<DeliveryClaim, "identity" | "delivery">>;
};
type Executor = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const unsupported = { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const;

/** Bind an autocommit executor. Never pass a transaction spanning host/provider I/O.
 * Missing fiscal facts or delivery binding refuse before writes; no scheduler is installed.
 */
export function createPostgresInvoiceStore(db: Executor, options?: Partial<DeliveryProjection> & { readonly seller?: InvoiceHostPorts["seller"] }): NativeStore {
  async function call<T>(name: string, values: unknown[]): Promise<T> {
    const result = await db.query(`SELECT public.${name}(${values.map((_, i) => `$${i + 1}`).join(",")}) AS response`, values);
    if (result.rows[0]?.response === undefined) throw new Error("invoicing_native_response_missing");
    return result.rows[0].response as T;
  }
  const fence = (claim: InvoiceClaim) => [claim.dutyId, claim.token, claim.generation];
  return {
    ...createNativeUnsupportedInvoicePorts().store,
    async discoverDuties(limit, afterDutyId = null) {
      const result = await db.query(`SELECT d.id AS "dutyId", d.order_id AS "orderId"
        FROM public.invoicing_duties d
        WHERE ($2::uuid IS NULL OR d.id>$2::uuid)
          AND d.request_id IS NULL AND d.status IN ('owed','blocked')
          AND d.reversal IS NULL AND d.available_at<=now()
          AND NOT EXISTS (SELECT 1 FROM public.invoicing_fact_revisions f WHERE f.duty_id=d.id)
        ORDER BY d.id LIMIT least(greatest(coalesce($1::integer,10),1),100)`, [limit, afterDutyId]);
      return result.rows.map(row => ({ dutyId: row.dutyId as string, orderId: row.orderId as string }));
    },
    async captureDuty(v) {
      try { return await call<Awaited<ReturnType<InvoiceStorePort["captureDuty"]>>>("invoicing_request_with_seller_policy", [v.requestKey, v.sourceKind, v.sourceId, v.orderId, v.evidence, v.occurredAt]); }
      catch (error) { if (isConflict(error)) return { kind: "conflict", code: "identity_mismatch" }; throw error; }
    },
    async installFacts(v) {
      if (!validFacts(v.facts)) return unsupported;
      return call<Awaited<ReturnType<InvoiceStorePort["installFacts"]>>>("invoicing_install_facts", [v.dutyId, v.facts, v.facts.factRevision]);
    },
    sweep: limit => call("invoicing_sweep_duties", [limit]),
    async prepareFacts(v) {
      const result = await call<{ status: "owed" | "ready" | "issued" | "voided" | "unsupported" | "stale"; documentId?: string; requestId?: string; kind?: "retryable" | "legacy_facts_unproved" }>("invoicing_prepare_facts", [v.dutyId, v.token]);
      const { kind, ...rest } = result;
      return kind ? { ...rest, code: kind } : rest;
    },
    async finishFacts(v) {
      const result = await call<{ status: "owed" | "ready" | "issued" | "voided" | "unsupported" | "faulted" | "stale" }>("invoicing_finish_facts", [v.dutyId, v.token, { ...v.result, kind: v.result.code }]);
      return { ...result, dutyId: v.dutyId };
    },
    readDuties: orderId => call("invoicing_duty_readback", [orderId]),
    async claim(v) {
      if (!options?.seller) return unsupported;
      const selected = await claimInvoiceSellerRevision(() => options!.seller!.read({ orderId: v.orderId ?? null }));
      if (selected.kind !== "found") return unsupported;
      // Revisions are immutable. Refuse legacy/incomplete host projections before
      // the lease RPC mutates a duty; supported writers install through this store.
      const candidates = await db.query(`SELECT f.facts FROM public.invoicing_duties d
        JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
        WHERE ($1::uuid IS NULL OR d.order_id=$1) AND (d.provider IS NULL OR d.provider=$2)
          AND d.status IN ('ready','processing','unknown') AND d.available_at<=now()
          AND (d.status<>'processing' OR d.lease_until<=now())`, [v.orderId ?? null, v.providerRef]);
      if (candidates.rows.some(row => !validFacts(row.facts as InvoiceFacts))) return unsupported;
      const rows = await call<Record<string, unknown>[]>("invoicing_claim_with_seller", [v.limit, v.visibilitySeconds, v.providerRef, selected.seller, selected.revisionRef, v.orderId ?? null]);
      return rows.map(row => {
        const facts = row.facts as InvoiceFacts & { before?: InvoiceFacts; reason?: string; parentExternalId?: string };
        if (!validFacts(facts)) throw new Error("invoicing_native_facts_invalid");
        const correction = row.parent_duty_id !== null;
        return {
          dutyId: row.id as string, documentId: row.document_id as string, requestId: row.request_id as string,
          token: row.claim_token as string, generation: row.generation as number, leaseUntil: row.lease_until as string,
          identity: identity(row, facts), facts: { ...facts, seller: row.seller as InvoiceFacts["seller"], sellerRevision: row.sellerRevision as string, sellerMode: row.sellerMode as "frozen" | "legacy_fallback" },
          action: (row.last_result as { action: "create" | "readback" }).action,
          correction: correction ? { before: facts.before!, reason: facts.reason!, after: { totalNetMinor: 0, totalTaxMinor: 0, totalGrossMinor: 0 } } : null,
        };
      });
    },
    preflight: v => call("invoicing_preflight_duty", [...fence(v.claim), {
      kind: v.status === "unavailable" || v.status === "unknown" || v.status === "absent" || v.amountMinor === null || v.currency === null ? "unavailable" : "observed",
      outcome: v.status === "succeeded" ? "captured" : v.status,
      amountMinor: v.amountMinor, currency: v.currency, proof: v.status === "absent" ? v.evidence : v.proof,
    }]),
    async finish(v) {
      if (!sameIdentity(v.claim.identity, v.result.identity)) return unsupported;
      return call(v.claim.correction ? "invoicing_finish_correction" : "invoicing_finish_issue", [
        ...fence(v.claim), v.result.providerDocumentRef, v.result.providerDocumentNumber,
        { kind: v.result.kind === "issued" ? "issued" : "readback_found", externalId: v.result.providerDocumentRef,
          providerCreateIdentity: v.claim.identity.providerCreateIdentity, parentExternalId: v.claim.identity.parentProviderDocumentRef, proof: v.result.proof },
      ]);
    },
    async fail(v) {
      if (v.kind === "absent" && (!sameIdentity(v.claim.identity, v.evidence.identity)
        || !sameIdentity(v.claim.identity, v.evidence.evidence.scope)
        || v.evidence.evidence.exact !== true || v.evidence.evidence.complete !== true)) return unsupported;
      const evidence = v.kind === "absent"
        ? { kind: "authoritative_absence", providerCreateIdentity: v.claim.identity.providerCreateIdentity, proof: v.evidence.evidence }
        : { ...(v.kind === "retryable" ? { phase: "before_send" } : {}), proof: v.proof };
      const result = await call<{ kind: string }>("invoicing_fail_duty", [...fence(v.claim), v.kind, evidence, v.retrySeconds]);
      return { kind: result.kind === "stale" || result.kind === "voided" ? result.kind : "recorded" };
    },
    async requestReversal(v) {
      try {
      const result = await call<{ kind: "missing" | "voided" | "pending_readback" | "correction_requested" | "unsupported"; dutyId?: string; replayed?: boolean }>("invoicing_request_with_seller_policy", [v.requestKey, "correction", null, v.orderId, { ...v.proof, reason: v.reason }, null]);
      return result.kind === "unsupported" ? { ...result, kind: "unsupported_recorded" } : { ...result, kind: result.kind };
      } catch (error) { if (isConflict(error)) return { kind: "conflict", code: "identity_mismatch" }; throw error; }
    },
    async requestLocalDocument(v) {
      const result = await db.query(LOCAL_DOCUMENT_SQL, [v.requestKey, v.orderId, v.providerRef]);
      const response = result.rows[0]?.response as { replayed?: boolean; document?: { id?: string; status?: string } } | undefined;
      if (typeof response?.document?.id !== "string" || typeof response.replayed !== "boolean" || typeof response.document.status !== "string") throw new Error("accounting_paid_order_document_response_invalid");
      const document = (await db.query("SELECT document_ref FROM public.accounting_documents WHERE id=$1::uuid", [response.document.id])).rows[0];
      if (typeof document?.document_ref !== "string") throw new Error("accounting_paid_order_document_reference_missing");
      return { kind: "requested", documentId: response.document.id, invoiceRef: document.document_ref, replayed: response.replayed, status: response.document.status };
    },
    async claimDeliveries(v) {
      if (typeof options?.projectDelivery !== "function") return unsupported;
      const rows = await call<{ delivery_id: string; document_id: string; channel: string; recipient_reference: string; claim_token: string; generation: number }[]>(
        "invoicing_claim_deliveries", [v.limit, v.visibilitySeconds, v.requireClearance, v.orderId ?? null]);
      const claims: DeliveryClaim[] = [];
      for (const row of rows) {
        let retryable = true;
        try {
          const projected = await options!.projectDelivery!({ deliveryRef: row.delivery_id, documentId: row.document_id,
            channel: row.channel, recipientRef: row.recipient_reference, attemptCount: row.generation });
          const doc = (await db.query("SELECT order_id, provider_reference FROM public.accounting_documents WHERE id=$1::uuid", [row.document_id])).rows[0];
          const { identity, delivery } = projected;
          if (!doc || !nonempty(doc.provider_reference) || identity.documentRef !== row.document_id
            || identity.providerDocumentRef !== doc.provider_reference || delivery.documentRef !== row.document_id
            || delivery.deliveryRef !== row.delivery_id || delivery.orderId !== doc.order_id
            || delivery.providerDocumentRef !== doc.provider_reference || delivery.attemptCount !== row.generation
            || delivery.orderRef !== identity.orderRef || delivery.invoiceRef !== identity.invoiceRef
            || !nonempty(delivery.requestKey) || !nonempty(delivery.recipient)) {
            retryable = false;
            throw new Error("invoicing_delivery_projection_invalid");
          }
          claims.push({ ...projected, token: row.claim_token, generation: row.generation, providerDocumentRef: doc.provider_reference });
        } catch {
          const settled = await call<{ kind: string }>("invoicing_settle_delivery", [
            row.delivery_id, row.claim_token, row.generation, "failed_before_send", null,
            { phase: "before_send", retryable, retrySeconds: Math.min(3600, 300 * Math.max(1, row.generation)),
              code: retryable ? "retryable" : "identity_mismatch" },
          ]);
          if (settled.kind !== "failed_before_send") throw new Error("invoicing_delivery_fence");
        }
      }
      return claims;
    },
    async settleDelivery(v) {
      if (typeof options?.projectDelivery !== "function") return unsupported;
      const doc = (await db.query(`SELECT doc.provider_reference FROM public.accounting_document_deliveries d
        JOIN public.accounting_documents doc ON doc.id=d.document_id WHERE d.id=$1::uuid`, [v.deliveryRef])).rows[0];
      if (!doc || doc.provider_reference !== v.providerDocumentRef) return unsupported;
      const result = v.result;
      const kind = result.kind === "provider_accepted" ? "sent" : result.kind;
      const receipt = result.kind === "provider_accepted" ? result.receiptRef : null;
      const evidence = result.kind === "failed_before_send"
        ? { phase: "before_send", retryable: result.retryable, retrySeconds: v.retrySeconds, code: result.code }
        : result.kind === "uncertain" ? { code: result.code, receiptHint: result.receiptRef } : { proof: result.proof };
      const settled = await call<{ kind: string; replayed?: boolean }>("invoicing_settle_delivery",
        [v.deliveryRef, v.token, v.generation, kind, receipt, evidence]);
      return { kind: settled.kind === "stale" ? "stale" : "recorded", replayed: settled.replayed ?? false };
    },
  };
}

function isConflict(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "23505"; }
function sameIdentity(a: InvoiceIdentity, b: InvoiceIdentity): boolean {
  return (Object.keys(a) as (keyof InvoiceIdentity)[]).every(key => a[key] === b[key]);
}
function identity(row: Record<string, unknown>, facts: InvoiceFacts & { parentExternalId?: string }): InvoiceIdentity {
  const correction = row.parent_duty_id !== null;
  return {
    providerRef: row.provider as string, requestKey: row.original_key as string,
    providerCreateIdentity: row.providerCreateIdentity as string, factRevision: facts.factRevision,
    orderRef: facts.refs.orderRef, invoiceRef: facts.refs.invoiceRef,
    operation: correction ? "full_reversal" : "issue", correctionRef: correction ? `invoicing:${row.id}` : null,
    parentProviderDocumentRef: correction ? facts.parentExternalId! : null,
  };
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validFacts(facts: InvoiceFacts): boolean {
  if (!facts || !nonempty(facts.factRevision) || !nonempty(facts.policyVersion) || !nonempty(facts.documentKind)
    || !facts.refs?.orderId || !facts.refs.orderRef || !facts.refs.invoiceRef || !facts.dates?.issueDate || !facts.dates.sellDate
    || !facts.buyer?.name || !facts.payment?.intentRef || facts.payment.currency !== facts.currency || typeof facts.clearanceRequired !== "boolean"
    || facts.currency?.length !== 3 || !Array.isArray(facts.lines) || !facts.lines.length) return false;
  const sums = [0, 0, 0];
  for (const line of facts.lines) {
    if (!line || !nonempty(line.description) || !Number.isSafeInteger(line.quantity) || line.quantity < 1
      || !Number.isSafeInteger(line.taxRateBps) || line.taxRateBps < 0 || line.taxRateBps > 10000
      || ![line.unitNetMinor, line.unitGrossMinor, line.totalNetMinor, line.totalTaxMinor, line.totalGrossMinor].every(Number.isSafeInteger)
      || line.totalNetMinor < 0 || line.totalTaxMinor < 0 || line.totalNetMinor + line.totalTaxMinor !== line.totalGrossMinor) return false;
    sums[0] += line.totalNetMinor; sums[1] += line.totalTaxMinor; sums[2] += line.totalGrossMinor;
  }
  return [facts.totalNetMinor, facts.totalTaxMinor, facts.totalGrossMinor].every((n, i) => Number.isSafeInteger(n) && n === sums[i])
    && facts.chargedTotalGrossMinor === facts.totalGrossMinor;
}

// Incumbent local-only constructor, byte-preserved SQL; zero tax is not a fiscal projection.
const LOCAL_DOCUMENT_SQL = `
  WITH snapshot AS (
    SELECT
      order_row.total_amount_minor,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'description', 'order position ' || item.line_ordinal::text,
            'quantity', item.quantity,
            'unitGrossMinor', item.unit_amount_minor,
            'totalGrossMinor', item.line_amount_minor,
            'taxRateBps', 0
          ) ORDER BY item.line_ordinal
        ) FILTER (WHERE item.id IS NOT NULL),
        '[]'::jsonb
      ) AS positions
    FROM public.commerce_orders order_row
    LEFT JOIN public.commerce_order_items item ON item.order_id = order_row.id
    WHERE order_row.id = $2::uuid
    GROUP BY order_row.id, order_row.total_amount_minor
  )
  SELECT public.accounting_document_request_from_paid_order(
    $1, $2::uuid, snapshot.positions, snapshot.total_amount_minor,
    jsonb_build_object('providerKind', $3::text)
  ) AS response
  FROM snapshot`;

type MoneyEvidence = Awaited<ReturnType<InvoiceHostPorts["money"]["read"]>>;
class ClaimFenceError extends Error {}

/** Native issue/readback binding; every store operation commits before host I/O.
 * @consumer Explicit native host issue binding and installed-consumer conformance.
 */
export async function runNativeInvoiceIssueJob(input: {
  store: Pick<InvoiceStorePort, "claim" | "preflight" | "finish" | "fail">;
  provider: Pick<InvoiceProviderPort, "issue" | "correct" | "read">;
  money: InvoiceHostPorts["money"];
  readLocalPayment(claim: InvoiceClaim): Promise<MoneyEvidence>;
  providerRef: string;
  orderId?: string | null;
  limit?: number;
  visibilitySeconds?: number;
}) {
  const batch = await input.store.claim({ limit: input.limit ?? 10, visibilitySeconds: input.visibilitySeconds ?? 300,
    providerRef: input.providerRef, orderId: input.orderId });
  if ("kind" in batch) return batch;
  let updated = 0, failures = 0;
  for (const native of batch) {
    const claim = { ...native, attemptCount: native.generation };
    let remoteStarted = false;
    const retrySeconds = Math.min(3600, 300 * Math.max(1, claim.attemptCount));
    const check = (result: { kind: string }) => {
      if (result.kind === "stale") throw new ClaimFenceError("invoicing_claim_fence");
      if (result.kind === "unsupported") throw new Error("invoicing_host_binding_required");
    };
    const fail = async (outcome: Parameters<InvoiceStorePort["fail"]>[0]) => {
      check(await input.store.fail(outcome));
    };
    const preflight = async (evidence: MoneyEvidence) => {
      const common = { claim, amountMinor: evidence.kind === "observed" ? evidence.amountMinor : null,
        currency: evidence.kind === "observed" ? evidence.currency : null };
      const result = await input.store.preflight(evidence.kind === "absent"
        ? { ...common, status: "absent", evidence: evidence.evidence }
        : { ...common, status: evidence.kind === "observed" ? evidence.status : "unavailable",
          proof: evidence.kind === "observed" ? evidence.proof : null });
      check(result);
      return result.kind;
    };
    try {
      if (claim.action === "readback") {
        remoteStarted = true;
        const result = await input.provider.read(claim.identity);
        if (result.kind === "found") {
          check(await input.store.finish({ claim, result }));
          updated++;
        } else {
          await fail(result.kind === "absent" ? { claim, retrySeconds, kind: "absent", evidence: result }
            : { claim, retrySeconds, kind: "unknown", proof: null });
          failures++;
        }
        continue;
      }
      // Non-observed local evidence is unavailable, never a reason to stop the
      // owed duty. A fresh authoritative host read still runs before dispatch.
      const local = await preflight(await input.readLocalPayment(claim));
      if (local === "blocked" || local === "mismatch") {
        await fail({ claim, retrySeconds, kind: "blocked", proof: null });
        failures++; continue;
      }
      const fresh = await preflight(await input.money.read({ intentRef: claim.facts.payment.intentRef,
        providerRef: claim.facts.payment.providerRef ?? input.providerRef,
        providerPaymentRef: claim.facts.payment.providerPaymentRef,
        expectedMoney: { amountMinor: claim.facts.totalGrossMinor, currency: claim.facts.currency } }));
      if (fresh !== "ready") {
        await fail(fresh === "unavailable" ? { claim, retrySeconds, kind: "retryable", phase: "before_send", proof: null }
          : { claim, retrySeconds, kind: "blocked", proof: null });
        failures++; continue;
      }
      const correctionFacts = claim.correction && { ...claim.correction.before,
        seller: claim.facts.seller, sellerRevision: claim.facts.sellerRevision, sellerMode: claim.facts.sellerMode };
      remoteStarted = true;
      const result = claim.correction
        ? await input.provider.correct({ identity: { ...claim.identity, operation: "full_reversal",
          correctionRef: claim.identity.correctionRef!, parentProviderDocumentRef: claim.identity.parentProviderDocumentRef! },
          ...claim.correction,
          before: correctionFacts!,
          recoveryLookupRequired: claim.attemptCount > 1 })
        : await input.provider.issue({ identity: { ...claim.identity, operation: "issue", correctionRef: null, parentProviderDocumentRef: null },
          facts: claim.facts, recoveryLookupRequired: claim.attemptCount > 1 });
      if (result.kind === "issued") {
        check(await input.store.finish({ claim, result })); updated++;
      } else {
        await fail(result.kind === "refused" && result.retryable
          ? { claim, retrySeconds, kind: "retryable", phase: "before_send", proof: null }
          : { claim, retrySeconds, kind: result.kind === "refused" ? "blocked" : result.kind === "unsupported" ? "unsupported" : "unknown", proof: null });
        failures++;
      }
    } catch (error) {
      failures++;
      if (error instanceof ClaimFenceError) continue;
      const recorded = await input.store.fail(remoteStarted ? { claim, retrySeconds, kind: "unknown", proof: null }
        : { claim, retrySeconds, kind: "retryable", phase: "before_send", proof: null });
      if (recorded.kind !== "stale") check(recorded);
    }
  }
  return { checked: batch.length, updated, failures, ok: failures === 0 };
}
