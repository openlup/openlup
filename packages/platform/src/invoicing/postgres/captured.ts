import { createHash } from "node:crypto";
import type { InvoiceFacts, InvoiceHostPorts, InvoiceIdentity, InvoiceProviderPort, InvoiceWriteResult } from "../contracts/index.js";
import { assertInvoicePdf } from "../artifacts.js";

/** Structural, autocommit PostgreSQL executor; no driver or connection discovery. */
export interface InvoicePostgresExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const capturedInvoiceFormat = "openlup.captured-invoice.v1";
const unsupported = { kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false } as const;
export const unknown = { kind: "unknown", code: "unknown" } as const;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function receiptKey(identity: InvoiceIdentity): string {
  return `captured-invoice:${digest([identity.providerRef, identity.providerCreateIdentity])}`;
}
export function artifactRef(key: string): string { return `${key}:pdf`; }
export interface CapturedReceipt {
  format: typeof capturedInvoiceFormat;
  kind: "artifacts";
  identity: InvoiceIdentity;
  inputHash: string;
  providerDocumentRef: string;
  providerDocumentNumber: string;
  pdf: string;
  observedAt: string;
  proof: { evidenceRef: string; fingerprint: string; observedAt: string };
}
export function capturedReceipt(value: unknown): CapturedReceipt | null {
  const row = value as CapturedReceipt | null;
  if (!row || row.format !== capturedInvoiceFormat || row.kind !== "artifacts" || !row.identity
    || typeof row.pdf !== "string" || typeof row.inputHash !== "string" || !row.proof
    || row.proof.evidenceRef !== receiptKey(row.identity) || row.proof.observedAt !== row.observedAt
    || row.providerDocumentRef !== `captured:${digest([row.identity.providerRef, row.identity.providerCreateIdentity])}`
    || typeof row.providerDocumentNumber !== "string") return null;
  const { proof, ...payload } = row;
  if (proof.fingerprint !== digest(payload)) return null;
  try { assertInvoicePdf({ content: Buffer.from(row.pdf, "base64"), contentType: "application/pdf" }); }
  catch { return null; }
  return row;
}

/** Explicit sandbox provider. Receipts and NON-FISCAL PDF bytes are append-only
 * artifact observations in the native database. No external fiscal effect,
 * clearance submission, email or numbering authority is claimed. Enable only
 * in the host's selected sandbox composition; void and artifact writes refuse.
 */
export function createCapturedPostgresInvoiceProvider(db: InvoicePostgresExecutor, options: {
  readonly enabled: boolean;
  readonly providerRef: string;
}): { provider: InvoiceProviderPort; artifacts: InvoiceHostPorts["artifacts"] } {
  if (!options.providerRef.trim()) throw new Error("captured_invoice_provider_required");
  const selected = (identity: { providerRef: string }) => options.enabled === true && identity.providerRef === options.providerRef;
  const context = async (identity: InvoiceIdentity) => {
    const result = await db.query(`SELECT d.id,d.document_id,d.status,d.generation,d.preflight_generation,d.original_key,d.provider,
      d.parent_duty_id,f.facts,s.seller_facts,s.revision_ref,parent.provider_reference AS parent_reference
      FROM public.invoicing_duties d JOIN public.invoicing_fact_revisions f ON f.duty_id=d.id
      LEFT JOIN public.invoicing_seller_revisions s ON s.duty_id=d.id
      LEFT JOIN public.accounting_documents parent ON parent.id=(SELECT document_id FROM public.invoicing_duties WHERE id=d.parent_duty_id)
      WHERE 'invoicing:'||d.id::text=$1 AND d.provider=$2`, [identity.providerCreateIdentity, options.providerRef]);
    const row = result.rows[0];
    if (!row) return null;
    const facts = row.facts as InvoiceFacts & { before?: InvoiceFacts; after?: unknown; reason?: string };
    const expected: InvoiceIdentity = { providerRef: options.providerRef, requestKey: row.original_key as string,
      providerCreateIdentity: `invoicing:${row.id}`, factRevision: facts.factRevision,
      orderRef: facts.refs.orderRef, invoiceRef: facts.refs.invoiceRef,
      operation: row.parent_duty_id ? "full_reversal" : "issue", correctionRef: row.parent_duty_id ? `invoicing:${row.id}` : null,
      parentProviderDocumentRef: row.parent_duty_id ? row.parent_reference as string : null };
    return canonical(expected) === canonical(identity) ? { row, facts } : null;
  };
  const readReceipt = async (identity: InvoiceIdentity) => {
    const rows = await db.query("SELECT observation FROM public.invoicing_document_observations WHERE event_key=$1", [receiptKey(identity)]);
    if (!rows.rows.length) return { absent: true as const, receipt: null };
    const receipt = capturedReceipt(rows.rows[0]!.observation);
    return { absent: false as const, receipt: receipt && canonical(receipt.identity) === canonical(identity) ? receipt : null };
  };
  const write = async (identity: InvoiceIdentity, facts: InvoiceFacts, extra: unknown): Promise<InvoiceWriteResult> => {
    if (!selected(identity)) return unsupported;
    const refused = (code: "identity_mismatch" | "blocked") => ({ kind: "refused", identity, code, retryable: false, effectMayHaveSucceeded: false } as const);
    try {
      const native = await context(identity);
      if (!native) return refused("identity_mismatch");
      const expectedFacts = native.facts.before ?? native.facts;
      // The first-claim seller is stored independently of the immutable buyer/line facts.
      // Legacy fallback seller remains supplied by the native claim wrapper.
      const projected = { ...expectedFacts, ...(native.row.seller_facts ? {
        seller: native.row.seller_facts, sellerRevision: native.row.revision_ref, sellerMode: "frozen",
      } : { seller: facts.seller, sellerRevision: (facts as InvoiceFacts & { sellerRevision?: string }).sellerRevision,
        sellerMode: "legacy_fallback" }) };
      if (canonical(projected) !== canonical(facts)
        || (native.facts.before && canonical(extra) !== canonical({ after: native.facts.after, reason: native.facts.reason }))) return refused("identity_mismatch");
      if (facts.clearanceRequired) return refused("blocked");
      const inputHash = digest({ facts, extra });
      const prior = await readReceipt(identity);
      if (!prior.absent) {
        if (!prior.receipt) return { ...unknown, identity, effectMayHaveSucceeded: true };
        if (prior.receipt.inputHash !== inputHash) return refused("identity_mismatch");
        return { kind: "issued", identity, providerDocumentRef: prior.receipt.providerDocumentRef,
          providerDocumentNumber: prior.receipt.providerDocumentNumber, proof: prior.receipt.proof, replayed: true };
      }
      const key = receiptKey(identity), observedAt = new Date().toISOString();
      const payload: Omit<CapturedReceipt, "proof"> = { format: capturedInvoiceFormat, kind: "artifacts" as const, identity, inputHash,
        providerDocumentRef: `captured:${digest([identity.providerRef, identity.providerCreateIdentity])}`,
        providerDocumentNumber: `CAPTURED/${identity.providerCreateIdentity.slice("invoicing:".length)}`,
        pdf: previewPdf(identity, facts).toString("base64"), observedAt };
      const receipt: CapturedReceipt = { ...payload, proof: { evidenceRef: key, fingerprint: digest(payload), observedAt } };
      // The existing append-only table grant suffices. A single statement fences
      // insertion against an unprepared/stale native claim; no new SQL routine.
      const inserted = await db.query(`INSERT INTO public.invoicing_document_observations(event_key,document_id,observation,observed_at)
        SELECT $1,d.document_id,$2::jsonb,$3::timestamptz FROM public.invoicing_duties d
        WHERE d.id=$4::uuid AND d.status='processing' AND d.preflight_generation=d.generation
          AND d.lease_until>now() AND d.document_id IS NOT NULL FOR UPDATE OF d
        ON CONFLICT (event_key) DO NOTHING RETURNING event_key`, [key, JSON.stringify(receipt), observedAt, native.row.id]);
      const stored = (await readReceipt(identity)).receipt;
      if (!stored) return { ...unknown, identity, effectMayHaveSucceeded: true };
      if (stored.inputHash !== inputHash) return refused("identity_mismatch");
      return { kind: "issued", identity, providerDocumentRef: stored.providerDocumentRef,
        providerDocumentNumber: stored.providerDocumentNumber, proof: stored.proof, replayed: inserted.rows.length === 0 };
    } catch { return { ...unknown, identity, effectMayHaveSucceeded: true }; }
  };
  const artifacts: InvoiceHostPorts["artifacts"] = {
    async read(input) {
      if (!selected(input.identity) || input.kind !== "pdf") return unsupported;
      try {
        const rows = await db.query("SELECT observation FROM public.invoicing_document_observations WHERE document_id=$1::uuid AND observation->>'format'=$2", [input.identity.documentRef, capturedInvoiceFormat]);
        if (rows.rows.length !== 1) return { ...unknown, identity: input.identity };
        const receipt = capturedReceipt(rows.rows[0]!.observation);
        if (!receipt || receipt.identity.providerRef !== input.identity.providerRef
          || receipt.identity.orderRef !== input.identity.orderRef || receipt.identity.invoiceRef !== input.identity.invoiceRef
          || receipt.identity.parentProviderDocumentRef !== input.identity.parentProviderDocumentRef
          || receipt.providerDocumentRef !== input.identity.providerDocumentRef) return { ...unknown, identity: input.identity };
        return { kind: "found", identity: input.identity, artifact: { kind: "pdf", ref: artifactRef(receiptKey(receipt.identity)),
          owner: "host_storage", mediaType: "application/pdf", proof: receipt.proof } };
      } catch { return { ...unknown, identity: input.identity }; }
    },
    async download(input) {
      const result = await artifacts.read({ identity: input.identity, kind: "pdf" });
      if (result.kind !== "found") return result.kind === "unsupported" ? unsupported : unknown;
      if (input.artifactRef !== result.artifact.ref) return unknown;
      try {
        const rows = await db.query("SELECT observation FROM public.invoicing_document_observations WHERE event_key=$1 AND document_id=$2::uuid", [result.artifact.proof.evidenceRef, input.identity.documentRef]);
        const receipt = capturedReceipt(rows.rows[0]?.observation);
        if (!receipt || receipt.proof.fingerprint !== result.artifact.proof.fingerprint) return unknown;
        return { kind: "downloaded", content: Buffer.from(receipt.pdf, "base64"), contentType: "application/pdf" };
      } catch { return unknown; }
    },
    async persist() { return unsupported; },
  };
  return { artifacts, provider: {
    issue: input => input.identity.operation === "issue" && input.identity.correctionRef === null && input.identity.parentProviderDocumentRef === null
      ? write(input.identity, input.facts, null) : Promise.resolve(unsupported),
    correct: input => input.identity.operation === "full_reversal" && input.identity.correctionRef && input.identity.parentProviderDocumentRef
      && Object.values(input.after).every(value => value === 0) && input.before.totalGrossMinor > 0
      ? write(input.identity, input.before, { after: input.after, reason: input.reason }) : Promise.resolve(unsupported),
    async read(identity) {
      if (!selected(identity) || identity.operation === "remote_void") return unsupported;
      try {
        if (!await context(identity)) return { ...unknown, identity };
        const { receipt, absent } = await readReceipt(identity);
        if (receipt) return { kind: "found", identity, providerDocumentRef: receipt.providerDocumentRef, providerDocumentNumber: receipt.providerDocumentNumber, proof: receipt.proof };
        if (!absent) return { ...unknown, identity };
        const scope = { identity, scope: identity, exact: true as const, complete: true as const };
        return { kind: "absent", identity, evidence: { ...scope, evidenceRef: receiptKey(identity), fingerprint: digest(scope), observedAt: new Date().toISOString() } };
      } catch { return { ...unknown, identity }; }
    },
    async void() { return unsupported; },
  } };
}

function previewPdf(identity: InvoiceIdentity, facts: InvoiceFacts): Buffer {
  const lines = ["CAPTURED INVOICE - NON-FISCAL TEST DOCUMENT", "No real invoice, clearance submission or email.",
    identity.invoiceRef, `${identity.operation === "full_reversal" ? "-" : ""}${facts.totalGrossMinor} ${facts.currency} minor units`];
  const content = `BT /F1 12 Tf 40 740 Td ${lines.map((line, i) => `${i ? "0 -24 Td " : ""}(${line.replace(/[^ -~]/g, "?").replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const result = Buffer.from(pdf);
  assertInvoicePdf({ content: result, contentType: "application/pdf" });
  return result;
}
