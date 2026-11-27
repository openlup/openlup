import {
  CARRIER_DISPLAY_NAME,
  CARRIER_ENDPOINT,
  CARRIER_SOAP_RESPONSE_MAX_BYTES,
  callCarrierSoap,
  escapeXml,
  extractFault,
  extractXmlValue,
} from "../../infra/dhl/adminDhlSoap.js";

export const CLEANUP_URL = CARRIER_ENDPOINT;
export { escapeXml, extractXmlValue };

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
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface CleanupResponse {
  dhl_deleted?: boolean;
  dhl_error?: string | null;
  label_deleted?: boolean;
  can_proceed?: boolean;
  error?: unknown;
}

export function createCleanupAction({
  createClient,
  fetchImpl,
  username,
  password,
  log = () => undefined,
  timeoutMs,
  maxBodyBytes,
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
          const response = await callCarrierSoap(
            fetchImpl,
            "deleteShipments",
            deletionEnvelope(trackingNumber, username, password),
            {
              timeoutMs,
              maxBodyBytes: maxBodyBytes ?? CARRIER_SOAP_RESPONSE_MAX_BYTES,
              signal: request.signal,
            },
          );
          const responseText = response.text;
          log("[CLEANUP] deleteShipments response:", responseText.slice(0, 500));

          const fault = extractFault(responseText);
          if (fault) {
            providerError = fault;
          } else if (!response.ok) {
            providerError = `${CARRIER_DISPLAY_NAME} HTTP ${response.status}`;
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
