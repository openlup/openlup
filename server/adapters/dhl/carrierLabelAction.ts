import {
  buildGetLabelsEnvelope,
  callCarrierSoap,
  CARRIER_NAMESPACE,
} from "../../infra/dhl/adminDhlSoap.js";

export { CARRIER_NAMESPACE as CARRIER_LABEL_ENDPOINT };
export const LABEL_URL_TTL_SECONDS = 300;

export type CarrierLabelClient = {
  auth: {
    getUser: (token: string) => Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
  from: (table: string) => {
    select: (columns: string) => {
      eq: (field: string, value: string) => {
        maybeSingle: () => Promise<{ data: { id: string } | null }>;
        single: () => Promise<{
          data: { id: string; tracking_number: string | null; label_url: string | null } | null;
          error: { message?: string } | null;
        }>;
      };
    };
    update: (row: Record<string, unknown>) => {
      eq: (field: string, value: string) => Promise<{ error?: { message?: string } | null }>;
    };
  };
  storage: {
    from: (bucket: string) => {
      upload: (path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }) =>
        Promise<{ error: { message: string } | null }>;
      createSignedUrl: (path: string, expiresIn: number) =>
        Promise<{ data: { signedUrl: string } | null; error: { message?: string } | null }>;
    };
  };
};

export type CarrierLabelOperation = (input: {
  trackingNumber: string;
}) => Promise<{ labelData: string | null; fault: string | null }>;

export type CarrierLabelActionDeps = {
  createClient: () => CarrierLabelClient;
};

export function escapeCarrierLabelXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function extractCarrierLabelXmlValue(xml: string, tagName: string): string | null {
  const namespaced = new RegExp(`<[^:]+:${tagName}[^>]*>([^<]*)<\\/[^:]+:${tagName}>`, "i");
  const namespacedMatch = xml.match(namespaced);
  if (namespacedMatch) return namespacedMatch[1];
  const plain = new RegExp(`<${tagName}[^>]*>([^<]*)<\\/${tagName}>`, "i");
  return xml.match(plain)?.[1] ?? null;
}

export function createCarrierLabelOperation(input: {
  fetchImpl: typeof fetch;
  username: string;
  password: string;
}): CarrierLabelOperation {
  return async ({ trackingNumber }) => {
    const { text: xml } = await callCarrierSoap(
      input.fetchImpl,
      "getLabels",
      buildGetLabelsEnvelope({ username: input.username, password: input.password }, trackingNumber),
    );
    return {
      labelData: extractCarrierLabelXmlValue(xml, "labelData"),
      fault: extractCarrierLabelXmlValue(xml, "faultstring"),
    };
  };
}

export function createCarrierLabelAction({
  createClient,
}: CarrierLabelActionDeps) {
  return async function runCarrierLabelAction(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response("ok");
    try {
      const authorization = request.headers.get("Authorization");
      if (!authorization) return json({ error: "Unauthorized" });

      const client = createClient();
      const { data: userData, error: authError } = await client.auth.getUser(authorization.replace("Bearer ", ""));
      if (authError || !userData.user) return json({ error: "Invalid token" });
      const { data: admin } = await client.from("admin_users").select("id").eq("id", userData.user.id).maybeSingle();
      if (!admin) return json({ error: "Not an admin" });

      const { tester_id: testerId } = await request.json() as { tester_id?: string };
      if (!testerId) return json({ error: "Missing tester_id" });
      const { data: tester, error: testerError } = await client
        .from("testers").select("id, tracking_number, label_url").eq("id", testerId).single();
      if (testerError || !tester || !tester.tracking_number) {
        return json({ error: "Tester bez tracking number" });
      }

      const objectKey = tester.label_url ? privateLabelObjectKey(tester.label_url) : null;
      if (objectKey) {
        const { data: signed, error } = await client.storage
          .from("dhl-labels")
          .createSignedUrl(objectKey, LABEL_URL_TTL_SECONDS);
        if (!error && signed?.signedUrl) return json({ success: true, label_url: signed.signedUrl });
        return json({ error: "Historical DHL label is unavailable in storage" });
      }

      return json({ error: "Historical DHL label is not cached" });
    } catch (error) {
      return json({ error: String(error) });
    }
  };
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

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
