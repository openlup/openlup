export const CLEANUP_URL = "https://dhl24.com.pl/webapi2/provider/service.html?ws=1";

export interface CleanupClient {
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
      };
    };
  };
  storage: {
    from: (bucket: string) => {
      remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
    };
  };
}

export interface CleanupActionDeps {
  createClient: () => CleanupClient;
  fetchImpl: typeof fetch;
  username: string;
  password: string;
  log?: (...args: unknown[]) => void;
}

export interface CleanupResponse {
  dhl_deleted?: boolean;
  dhl_error?: string | null;
  label_deleted?: boolean;
  can_proceed?: boolean;
  error?: unknown;
}

export function escapeXml(value: unknown): string {
  const text = String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function extractXmlValue(xml: string, tagName: string): string | null {
  const namespaced = new RegExp(`<[^:]+:${tagName}[^>]*>([^<]*)<\\/[^:]+:${tagName}>`, "i");
  const namespacedMatch = xml.match(namespaced);
  if (namespacedMatch) return namespacedMatch[1];

  const plain = new RegExp(`<${tagName}[^>]*>([^<]*)<\\/${tagName}>`, "i");
  const plainMatch = xml.match(plain);
  return plainMatch ? plainMatch[1] : null;
}

export function createCleanupAction({
  createClient,
  fetchImpl,
  username,
  password,
  log = () => undefined,
}: CleanupActionDeps) {
  return async function runCleanupAction(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response("ok");

    try {
      const authorization = request.headers.get("Authorization");
      if (!authorization) return json({ error: "Unauthorized" });

      const client = createClient();
      const token = authorization.replace("Bearer ", "");
      const { data: userData, error: authError } = await client.auth.getUser(token);
      if (authError || !userData?.user) return json({ error: "Invalid token" });

      const { data: admin } = await client
        .from("admin_users")
        .select("id")
        .eq("id", userData.user.id)
        .maybeSingle();
      if (!admin) return json({ error: "Not an admin" });

      const { tracking_number: trackingNumber } = await request.json() as { tracking_number?: string };
      let providerDeleted = false;
      let providerError: string | null = null;
      let labelDeleted = false;

      if (trackingNumber) {
        try {
          const response = await fetchImpl(CLEANUP_URL, {
            method: "POST",
            headers: {
              "Content-Type": "text/xml; charset=utf-8",
              SOAPAction: `${CLEANUP_URL}#deleteShipments`,
            },
            body: deletionEnvelope(trackingNumber, username, password),
          });
          const responseText = await response.text();
          log("[CLEANUP] deleteShipments response:", responseText.slice(0, 500));

          const fault = extractXmlValue(responseText, "faultstring");
          if (fault) {
            providerError = fault;
          } else {
            const result = extractXmlValue(responseText, "result");
            if (result === "true" || result === "1") {
              providerDeleted = true;
            } else {
              providerError = extractXmlValue(responseText, "error") || "DHL nie potwierdził usunięcia";
            }
          }
        } catch (error) {
          providerError = String(error);
          log("[CLEANUP] provider error:", error);
        }
      }

      if (trackingNumber) {
        try {
          const { error } = await client.storage.from("dhl-labels").remove([`${trackingNumber}.pdf`]);
          labelDeleted = !error;
          if (error) log("[CLEANUP] Storage remove error:", error.message);
        } catch (error) {
          log("[CLEANUP] Storage error:", error);
        }
      }

      return json(cleanupResponse(providerDeleted, providerError, labelDeleted));
    } catch (error) {
      return json(cleanupResponse(false, String(error), false));
    }
  };
}

function deletionEnvelope(trackingNumber: string, username: string, password: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${CLEANUP_URL}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:deleteShipments>
      <authData>
        <username>${escapeXml(username)}</username>
        <password>${escapeXml(password)}</password>
      </authData>
      <shipments>
        <item>${escapeXml(trackingNumber)}</item>
      </shipments>
    </tns:deleteShipments>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function cleanupResponse(
  providerDeleted: boolean,
  providerError: string | null,
  labelDeleted: boolean,
): CleanupResponse {
  return {
    dhl_deleted: providerDeleted,
    dhl_error: providerError,
    label_deleted: labelDeleted,
    can_proceed: true,
  };
}

function json(body: CleanupResponse): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
