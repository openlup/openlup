type TestInvoiceDownloadTicket = {
  invoiceId?: string;
  invoiceRef: string;
  providerKind?: string;
  providerInvoiceId?: string;
  providerInvoiceNumber: string | null;
  fileName?: string;
};

export function createTestInvoicePdfProvider() {
  return {
    async downloadInvoicePdf(ticket: TestInvoiceDownloadTicket): Promise<{ content: Buffer; contentType: string }> {
      return {
        content: createTestInvoicePdf(ticket),
        contentType: "application/pdf",
      };
    },
  };
}

function createTestInvoicePdf(ticket: TestInvoiceDownloadTicket): Buffer {
  const title = `TEST INVOICE ${ticket.providerInvoiceNumber ?? ticket.invoiceRef}`;
  const lines = [
    "openlup ACCOUNTING PREVIEW",
    title,
    "NON-FISCAL TEST DOCUMENT",
    "No real invoice was issued.",
    "No email was sent.",
    "No KSeF submission was made.",
  ];
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 740 Td",
    ...lines.flatMap((line, index) => [
      index === 0 ? "" : "0 -34 Td",
      `(${escapePdfText(line)}) Tj`,
    ]).filter(Boolean),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];
  return buildPdf(objects);
}

function buildPdf(objects: string[]): Buffer {
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
