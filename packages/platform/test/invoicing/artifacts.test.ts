import { expect, it } from "vitest";
import { assertInvoicePdf, invoicePdfFilename } from "../../src/invoicing/index.js";

it("validates MIME, signature, size and empty bytes without inventing storage proof; sanitizes host filenames", () => {
  expect(() => assertInvoicePdf({ content: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf; charset=binary" })).not.toThrow();
  for (const [content, contentType] of [
    [new Uint8Array(), "application/pdf"], [new TextEncoder().encode("not-pdf"), "application/pdf"],
    [new TextEncoder().encode("%PDF-1.7"), "text/html"], [new Uint8Array(25 * 1024 * 1024 + 1), "application/pdf"],
  ] as const) expect(() => assertInvoicePdf({ content, contentType })).toThrow(/^invoice_pdf_/);
  expect(invoicePdfFilename(" ../INV/1 \r\n ")).toBe("INV-1.pdf");
  expect(invoicePdfFilename("///", "host caption")).toBe("host-caption.pdf");
});
