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
};

export function createMergeLabelDocumentsAction<TDocument extends PdfDoc, TPage>({
  createClient,
  createPdf,
  loadPdf,
  encodeBase64 = encodePdfBase64,
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

      const body = await request.json() as { tester_ids?: string[] };
      const testerIds = body.tester_ids ?? [];
      if (testerIds.length === 0) return json({ error: "Brak tester_ids" });
      const { data: testers, error } = await client
        .from("testers").select("id, first_name, last_name, tracking_number, label_url")
        .in("id", testerIds).not("label_url", "is", null);
      if (error || !testers || testers.length === 0) return json({ error: "Brak testerów z etykietami" });

      const storage = client.storage.from("dhl-labels");
      const mergedPdf = await createPdf();
      const errors: string[] = [];
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
          const document = await loadPdf(new Uint8Array(await data.arrayBuffer()));
          const pages = await mergedPdf.copyPages(document, document.getPageIndices());
          pages.forEach((page) => mergedPdf.addPage(page));
        } catch (error) {
          errors.push(`${labelOwner(tester)}: ${String(error)}`);
        }
      }
      if (mergedPdf.getPageCount() === 0) {
        return json({ error: "Nie udało się zmergować żadnej etykiety", errors });
      }
      const result = {
        success: true,
        pdf_base64: encodeBase64(new Uint8Array(await mergedPdf.save())),
        label_count: mergedPdf.getPageCount(),
        ...(errors.length > 0 ? { errors } : {}),
      };
      return json(result);
    } catch (error) {
      return json({ error: String(error) });
    }
  };
}

function labelOwner(tester: CarrierLabelRow): string {
  return `${tester.first_name ?? ""} ${tester.last_name ?? ""}`.trim();
}

function privateLabelObjectKey(value: string): string | null {
  if (value.trim() !== value || value.length === 0) return null;
  if (!/^https?:\/\//i.test(value)) return safeObjectKey(value) ? value : null;
  try {
    const path = new URL(value).pathname;
    const match = path.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/dhl-labels\/(.+)$/);
    if (!match) return null;
    const objectKey = decodeURIComponent(match[1]);
    return safeObjectKey(objectKey) ? objectKey : null;
  } catch {
    return null;
  }
}

function safeObjectKey(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("..");
}

function encodePdfBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
