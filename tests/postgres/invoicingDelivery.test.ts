import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresInvoiceStore, runInvoiceDeliveryJob } from "@openlup/platform/invoicing";
import type { InvoiceHostPorts, InvoiceStorePort } from "@openlup/platform/invoicing/contracts";
import { executor, fixture, nativeHarness } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const h = nativeHarness("invoicing-delivery");
let started: number;
beforeAll(async () => { await h.start(); started = performance.now(); }, postgresSetupTimeoutMs);
afterAll(async () => { await h.stop(); console.log(`M09 delivery whole-file ms=${Math.round(performance.now() - started)}`); }, postgresTeardownTimeoutMs);
type Claim = Exclude<Awaited<ReturnType<InvoiceStorePort["claimDeliveries"]>>, { kind: "unsupported" }>[number];
type Result = Parameters<InvoiceStorePort["settleDelivery"]>[0]["result"];
const proof = { evidenceRef: "transport-proof", fingerprint: "d".repeat(64), observedAt: "2026-10-23T12:34:56Z" };
const retry: Result = { kind: "failed_before_send", retryable: true, code: "retryable" };
const options = { limit: 1, visibilitySeconds: 173, requireClearance: false };
const rows = [
  { name: "missing binding refuses before claim", mode: "unbound" },
  { name: "malformed JavaScript binding refuses before claim", mode: "malformed" },
  { name: "claim projects distinct envelope fields and the native fence", mode: "claim" },
  { name: "sent records transport acceptance", mode: "job", outcome: "sent" },
  { name: "uncertain retains the hint and cannot resend", mode: "job", outcome: "uncertain" },
  { name: "retryable job carries bounded backoff", mode: "job", outcome: "retry", delay: 300 },
  { name: "invalid PDF retries before transport entry", mode: "job", outcome: "bad_pdf", delay: 300 },
  { name: "non-retryable job parks visibly", mode: "job", outcome: "terminal" },
  { name: "unsupported transport parks visibly", mode: "job", outcome: "unsupported" },
  { name: "zero delay clamps to 60", mode: "settle", delay: 0, expectedDelay: 60 },
  { name: "large delay clamps to 86400", mode: "settle", delay: 99999, expectedDelay: 86400 },
  { name: "absent delay defaults to 900", mode: "settle", expectedDelay: 900 },
  { name: "fractional delay defaults to 900", mode: "settle", delay: 12.5, expectedDelay: 900 },
  { name: "string delay defaults to 900", mode: "settle", delay: "123", expectedDelay: 900 },
  { name: "stale token writes nothing", mode: "stale" },
  { name: "provider mismatch refuses before settlement", mode: "mismatch" },
  { name: "cross-document projection never reaches transport", mode: "projection" },
  { name: "a projection failure retries before send while another leased row is sent", mode: "batch_projection" },
] as const;

it.each(rows)("native delivery: $name", async row => {
  const f = await fixture(h.pool);
  await h.pool.query("UPDATE public.commerce_orders SET paid_at=now() WHERE id=$1", [f.order]);
  const db = executor(h.pool), unbound = createPostgresInvoiceStore(db);
  const local = await unbound.requestLocalDocument({ requestKey: `local-document:${f.order}`, orderId: f.order, providerRef: "local-provider" });
  if (local.kind !== "requested") throw new Error("local document missing");
  const external = `provider-document:${randomUUID()}`, deliveryRef = randomUUID();
  await h.pool.query("SELECT public.accounting_document_advance($1,$2,'issued',$3,'{}')", [`advance:${randomUUID()}`, local.documentId, external]);
  await h.pool.query(`INSERT INTO public.accounting_document_deliveries(id,document_id,channel,recipient_reference,attempts)
    VALUES($1,$2,'host-receipt','recipient:opaque',0)`, [deliveryRef, local.documentId]);
  const envelope = {
    deliveryRef, requestKey: `exact delivery key:${deliveryRef} `, attemptCount: 1,
    documentRef: local.documentId, orderId: f.order, orderRef: "ORDER/DELIVERY", invoiceRef: "INVOICE/DELIVERY",
    providerDocumentRef: external, clientRef: f.client, recipient: "delivery@example.invalid", source: "host-source",
    providerDocumentNumber: "PROVIDER/NUMBER",
  };
  const identity = { providerRef: "fiscal-provider", documentRef: local.documentId, providerDocumentRef: external,
    orderRef: envelope.orderRef, invoiceRef: envelope.invoiceRef, parentProviderDocumentRef: "parent-provider-document" };
  const goodDeliveryRef = randomUUID();
  const goodEnvelope = { ...envelope, deliveryRef: goodDeliveryRef, requestKey: `delivery:${goodDeliveryRef}` };
  if (row.mode === "batch_projection") {
    await h.pool.query(`INSERT INTO public.accounting_document_deliveries(id,document_id,channel,recipient_reference,attempts)
      VALUES($1,$2,'host-receipt-other','recipient:other',0)`, [goodDeliveryRef, local.documentId]);
  }
  const store = createPostgresInvoiceStore(db, { async projectDelivery(input) {
    if (row.mode === "batch_projection") {
      if (input.deliveryRef === deliveryRef) throw new Error("host recipient lookup unavailable");
      expect(input).toEqual({ deliveryRef: goodDeliveryRef, documentId: local.documentId, channel: "host-receipt-other", recipientRef: "recipient:other", attemptCount: 1 });
      return { identity, delivery: goodEnvelope };
    }
    expect(input).toEqual({ deliveryRef, documentId: local.documentId, channel: "host-receipt", recipientRef: "recipient:opaque", attemptCount: 1 });
    return { identity: row.mode === "projection" ? { ...identity, documentRef: randomUUID() } : identity, delivery: envelope };
  } });
  const claimOptions = { ...options, limit: row.mode === "batch_projection" ? 2 : options.limit, orderId: f.order };
  const state = async (id = deliveryRef) => (await h.pool.query(`SELECT to_jsonb(d) AS delivery, to_jsonb(r) AS receipt,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attempt_ordinal),'[]') FROM public.accounting_document_delivery_attempts a WHERE a.delivery_id=d.id) AS attempts,
    CASE WHEN d.available_at='infinity' THEN NULL ELSE extract(epoch FROM d.available_at-d.updated_at)::integer END AS delay
    FROM public.accounting_document_deliveries d LEFT JOIN public.invoicing_delivery_receipts r ON r.delivery_id=d.id WHERE d.id=$1`, [id])).rows[0];
  const before = await state();
  if (row.mode === "unbound" || row.mode === "malformed") {
    const refused = row.mode === "unbound" ? unbound : createPostgresInvoiceStore(db, {} as never);
    expect(await refused.claimDeliveries(claimOptions)).toEqual({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false });
    expect(await state()).toEqual(before);
    return;
  }
  if (row.mode === "projection") {
    expect(await runInvoiceDeliveryJob({ enabled: true, providerEnabled: true, deliveryEnabled: true, store, claimOptions,
      download: async () => { throw new Error("must not download"); }, filename: () => "invoice.pdf",
      send: async () => { throw new Error("must not send"); } })).toEqual({ ok: true, checked: 0, updated: 0, skipped: false, failures: 0 });
    expect(await state()).toMatchObject({ delivery: { status: "failed", attempts: 1, available_at: "infinity",
      last_error: { phase: "before_send", retryable: false, code: "identity_mismatch" } },
      receipt: { state: "failed", generation: 1, claim_token: null, lease_until: null }, attempts: [{ outcome: "failed", attempt_ordinal: 1 }] });
    return;
  }
  if (row.mode === "batch_projection") {
    const downloads: string[] = [], sends: string[] = [];
    expect(await runInvoiceDeliveryJob({ enabled: true, providerEnabled: true, deliveryEnabled: true, store, claimOptions,
      download: async claim => {
        downloads.push(claim.delivery.deliveryRef);
        return { content: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" };
      }, filename: () => "invoice.pdf", send: async input => {
        sends.push(input.deliveryRef);
        expect(input).toEqual({ ...goodEnvelope, filename: "invoice.pdf", content: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" });
        return { kind: "provider_accepted", receiptRef: "batch-receipt", proof };
      } })).toEqual({ ok: true, checked: 1, updated: 1, skipped: false, failures: 0 });
    expect(downloads).toEqual([goodDeliveryRef]);
    expect(sends).toEqual([goodDeliveryRef]);
    const failed = await state(), sent = await state(goodDeliveryRef);
    expect(failed).toMatchObject({ delivery: { status: "failed", lease_until: null,
      last_error: { phase: "before_send", retryable: true, retrySeconds: 300, code: "retryable" } }, delay: 300,
      receipt: { state: "failed", claim_token: null, lease_until: null, result: { kind: "failed_before_send", receipt: null } },
      attempts: [{ outcome: "failed", attempt_ordinal: 1 }] });
    expect(failed.attempts[0].error).toEqual(failed.delivery.last_error);
    expect(sent).toMatchObject({ delivery: { status: "succeeded", receipt_reference: "batch-receipt", lease_until: null },
      receipt: { state: "sent", claim_token: null, lease_until: null }, attempts: [{ outcome: "delivered", attempt_ordinal: 1 }] });
    expect(await store.claimDeliveries(claimOptions)).toEqual([]);
    expect((await state()).receipt.state).toBe("failed");
    expect((await state(goodDeliveryRef)).receipt.state).toBe("sent");
    return;
  }
  if (row.mode === "job") {
    let sends = 0;
    const result = await runInvoiceDeliveryJob({ enabled: true, providerEnabled: true, deliveryEnabled: true, store, claimOptions,
      download: async () => ({ content: new TextEncoder().encode(row.outcome === "bad_pdf" ? "bad" : "%PDF-1.7"), contentType: "application/pdf" }),
      filename: () => "host-invoice.pdf", send: async input => {
        sends += 1;
        expect(input).toEqual({ ...envelope, filename: "host-invoice.pdf", content: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" });
        if (row.outcome === "sent") return { kind: "provider_accepted", receiptRef: "transport-receipt", proof };
        if (row.outcome === "uncertain") return { kind: "uncertain", code: "uncertain_delivery", receiptRef: "transport-hint" };
        if (row.outcome === "terminal") return { kind: "failed_before_send", retryable: false, code: "invalid_artifact" };
        if (row.outcome === "unsupported") return { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false };
        return retry as Awaited<ReturnType<InvoiceHostPorts["delivery"]["send"]>>;
      } });
    expect(result).toEqual({ ok: row.outcome === "sent", checked: 1, updated: row.outcome === "sent" ? 1 : 0, skipped: false, failures: row.outcome === "sent" ? 0 : 1 });
    expect(sends).toBe(row.outcome === "bad_pdf" ? 0 : 1);
    const saved = await state();
    if (row.outcome === "sent") {
      expect(saved).toMatchObject({ delivery: { status: "succeeded", receipt_reference: "transport-receipt", lease_until: null }, receipt: { state: "sent", claim_token: null, lease_until: null,
        result: { kind: "sent", receipt: "transport-receipt", evidence: { proof } } }, attempts: [{ outcome: "delivered", receipt_reference: "transport-receipt", attempt_ordinal: 1 }] });
      expect(saved.delivery.delivered_at).not.toBeNull();
    } else if (row.outcome === "uncertain") {
      expect(saved).toMatchObject({ delivery: { status: "processing", receipt_reference: null }, receipt: { state: "uncertain", claim_token: null, lease_until: null,
        result: { kind: "uncertain", receipt: null, evidence: { code: "uncertain_delivery", receiptHint: "transport-hint" } } }, attempts: [] });
    } else {
      const terminal = row.outcome === "terminal" || row.outcome === "unsupported";
      expect(saved).toMatchObject({ delivery: { status: "failed", lease_until: null, last_error: { phase: "before_send", retryable: !terminal } },
        receipt: { state: "failed", claim_token: null, lease_until: null, result: { kind: "failed_before_send", receipt: null } }, attempts: [{ outcome: "failed", attempt_ordinal: 1 }] });
      expect(saved.attempts[0].error).toEqual(saved.delivery.last_error);
      if (terminal) expect(saved.delivery.available_at).toBe("infinity");
      else { expect(saved.delay).toBe(row.delay); expect(saved.delivery.last_error.retrySeconds).toBe(row.delay); }
    }
    expect(await store.claimDeliveries(claimOptions)).toEqual([]);
    return;
  }
  const batch = await store.claimDeliveries(claimOptions);
  if ("kind" in batch) throw new Error("claim unsupported");
  const claim: Claim = batch[0]!;
  const claimed = await state();
  expect(batch).toEqual([{ identity, delivery: envelope, token: claimed.receipt.claim_token, generation: 1, providerDocumentRef: external }]);
  expect(claimed).toMatchObject({ delivery: { status: "processing", attempts: 1, lease_until: "infinity" }, receipt: { state: "processing", generation: 1 }, attempts: [] });
  expect(claim.token).not.toBe(deliveryRef);
  if (row.mode === "claim") return;
  const result = await store.settleDelivery({ deliveryRef, token: row.mode === "stale" ? randomUUID() : claim.token,
    generation: claim.generation, providerDocumentRef: row.mode === "mismatch" ? "wrong-provider-document" : external,
    retrySeconds: ("delay" in row ? row.delay : undefined) as number, result: retry });
  if (row.mode === "stale" || row.mode === "mismatch") {
    expect(result).toEqual(row.mode === "stale" ? { kind: "stale", replayed: false }
      : { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false });
    expect(await state()).toEqual(claimed);
    return;
  }
  expect(result).toEqual({ kind: "recorded", replayed: false });
  const saved = await state();
  expect(saved).toMatchObject({ delivery: { status: "failed", lease_until: null, last_error: { phase: "before_send", retryable: true, code: "retryable" } },
    receipt: { state: "failed", claim_token: null, lease_until: null }, attempts: [{ outcome: "failed", attempt_ordinal: 1 }] });
  expect(saved.delay).toBe(row.expectedDelay);
  expect(saved.attempts[0].error).toEqual(saved.delivery.last_error);
  expect(await store.claimDeliveries(claimOptions)).toEqual([]);
});
