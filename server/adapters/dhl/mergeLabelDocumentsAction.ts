import {
  CARRIER_LABELS_BUCKET,
  privateLabelObjectKey,
  sanitizeCarrierError,
} from "../../infra/dhl/adminDhlSoap.js";

export const MAX_MERGE_LABEL_DOCUMENTS = 50;
export const MAX_MERGE_LABEL_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_MERGE_LABEL_TOTAL_PAGES = 200;

export type CarrierLabelClient = {
  auth: {
    getUser: (token: string) => Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: { id: string } | null; error?: unknown }>;
      };
      in: (column: string, values: string[]) => {
        not: (column: string, operator: string, value: unknown) => Promise<{
          data: CarrierLabelRow[] | null;
          error: unknown;
        }>;
      };
    };
  };
  storage: {
    from: (bucket: string) => {
      download: (path: string) => Promise<{
        data: Blob | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

export type CarrierLabelRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  tracking_number: string | null;
  label_url: string | null;
};

type PdfDoc = { getPageIndices: () => number[] };
type MergedPdf<TDocument extends PdfDoc, TPage> = {
  copyPages: (doc: TDocument, indices: number[]) => Promise<TPage[]>;
  addPage: (page: TPage) => void;
  getPageCount: () => number;
  save: () => Promise<Uint8Array>;
};

export type MergeLabelDocumentsActionDeps<
  TDocument extends PdfDoc = PdfDoc,
  TPage = unknown,
> = {
  createClient: () => CarrierLabelClient;
  createPdf: () => Promise<MergedPdf<TDocument, TPage>>;
  loadPdf: (bytes: Uint8Array) => Promise<TDocument>;
  encodeBase64?: (bytes: Uint8Array) => string;
  maxDocuments?: number;
  maxTotalBytes?: number;
  maxTotalPages?: number;
};

export function createMergeLabelDocumentsAction<TDocument extends PdfDoc, TPage>({
  createClient,
  createPdf,
  loadPdf,
  encodeBase64 = encodePdfBase64,
  maxDocuments = MAX_MERGE_LABEL_DOCUMENTS,
  maxTotalBytes = MAX_MERGE_LABEL_TOTAL_BYTES,
  maxTotalPages = MAX_MERGE_LABEL_TOTAL_PAGES,
}: MergeLabelDocumentsActionDeps<TDocument, TPage>) {
  return async function runMergeLabelDocumentsAction(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response("ok");
    try {
      const authorization = request.headers.get("Authorization");
      if (!authorization) return json({ error: "Unauthorized" });

      const client = createClient();
      const { data: userData, error: authError } = await client.auth.getUser(authorization.replace("Bearer ", ""));
      if (authError || !userData.user) return json({ error: "Invalid token" });
      const { data: admin } = await client.from("admin_users").select("id").eq("id", userData.user.id).maybeSingle();
      if (!admin) return json({ error: "Not an admin" });

      const body = await request.json() as { tester_ids?: unknown };
      const testerIds = Array.isArray(body.tester_ids)
        ? body.tester_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      if (testerIds.length === 0) return json({ error: "Brak tester_ids" });
      if (testerIds.length > maxDocuments) {
        return json({ error: `Przekroczono limit etykiet do scalenia (maks. ${maxDocuments})` }, 400);
      }
      const { data: testers, error } = await client
        .from("testers").select("id, first_name, last_name, tracking_number, label_url")
        .in("id", testerIds).not("label_url", "is", null);
      if (error || !testers || testers.length === 0) return json({ error: "Brak testerów z etykietami" });
      if (testers.length > maxDocuments) {
        return json({ error: `Przekroczono limit etykiet do scalenia (maks. ${maxDocuments})` }, 400);
      }

      const storage = client.storage.from(CARRIER_LABELS_BUCKET);
      const mergedPdf = await createPdf();
      const errors: string[] = [];
      let totalBytes = 0;
      for (const tester of testers) {
        const objectKey = privateLabelObjectKey(tester.label_url!);
        if (!objectKey) {
          errors.push(`${labelOwner(tester)}: Historical DHL label is not cached`);
          continue;
        }
        try {
          const { data, error } = await storage.download(objectKey);
          if (error || !data) {
            errors.push(`${labelOwner(tester)}: Historical DHL label is unavailable in storage`);
            continue;
          }
          if (typeof data.size === "number" && totalBytes + data.size > maxTotalBytes) {
            return json({ error: `Przekroczono limit rozmiaru scalanych etykiet (${maxTotalBytes} B)` }, 413);
          }
          const bytes = new Uint8Array(await data.arrayBuffer());
          totalBytes += bytes.byteLength;
          if (totalBytes > maxTotalBytes) {
            return json({ error: `Przekroczono limit rozmiaru scalanych etykiet (${maxTotalBytes} B)` }, 413);
          }
          const document = await loadPdf(bytes);
          const pageIndices = document.getPageIndices();
          if (mergedPdf.getPageCount() + pageIndices.length > maxTotalPages) {
            return json({ error: `Przekroczono limit stron scalanych etykiet (maks. ${maxTotalPages})` }, 400);
          }
          const pages = await mergedPdf.copyPages(document, pageIndices);
          if (mergedPdf.getPageCount() + pages.length > maxTotalPages) {
            return json({ error: `Przekroczono limit stron scalanych etykiet (maks. ${maxTotalPages})` }, 400);
          }
          pages.forEach((page) => mergedPdf.addPage(page));
        } catch (error) {
          errors.push(`${labelOwner(tester)}: ${sanitizeCarrierError(error)}`);
        }
      }
      if (mergedPdf.getPageCount() === 0) {
        return json({ error: "Nie udało się zmergować żadnej etykiety", errors });
      }
      const savedBytes = new Uint8Array(await mergedPdf.save());
      if (savedBytes.byteLength > maxTotalBytes) {
        return json({ error: `Przekroczono limit rozmiaru scalanych etykiet (${maxTotalBytes} B)` }, 413);
      }
      const result = {
        success: true,
        pdf_base64: encodeBase64(savedBytes),
        label_count: mergedPdf.getPageCount(),
        ...(errors.length > 0 ? { errors } : {}),
      };
      return json(result);
    } catch (error) {
      return json({ error: sanitizeCarrierError(error) });
    }
  };
}

function labelOwner(tester: CarrierLabelRow): string {
  return `${tester.first_name ?? ""} ${tester.last_name ?? ""}`.trim();
}

function encodePdfBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function json(body: Record<string, unknown>, status?: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
