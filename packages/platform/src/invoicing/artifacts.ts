const MAX_INVOICE_PDF_BYTES = 25 * 1024 * 1024;

/** Validate transient bytes; this is neither storage proof nor delivery proof. */
export function assertInvoicePdf(pdf: { content: Uint8Array; contentType: string }): void {
  const contentType = pdf.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") throw new Error("invoice_pdf_content_type_invalid");
  if (!pdf.content || pdf.content.byteLength === 0) throw new Error("invoice_pdf_empty");
  if (pdf.content.byteLength > MAX_INVOICE_PDF_BYTES) throw new Error("invoice_pdf_too_large");
  if (String.fromCharCode(...pdf.content.subarray(0, 5)) !== "%PDF-") {
    throw new Error("invoice_pdf_signature_invalid");
  }
}

/** The host supplies its existing fallback caption. No locale/content default. */
export function invoicePdfFilename(reference: string, fallback = "invoice"): string {
  const safe = (value: string) => value.normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return `${safe(reference) || safe(fallback) || "invoice"}.pdf`;
}
