import {
  CARRIER_DISPLAY_NAME,
  CARRIER_NAMESPACE,
  CARRIER_SOAP_RESPONSE_MAX_BYTES,
  CARRIER_SOAP_TIMEOUT_MS,
  CarrierSoapResponseTooLargeError,
  callCarrierSoap,
  escapeXml,
  extractFault,
  sanitizeCarrierError,
} from "../../infra/dhl/adminDhlSoap.js";

export {
  CARRIER_NAMESPACE as CARRIER_TRACKING_ENDPOINT,
  CARRIER_SOAP_TIMEOUT_MS,
  CarrierSoapResponseTooLargeError,
  sanitizeCarrierError,
};
export const CARRIER_HTTP_ERROR_PREFIX = `${CARRIER_DISPLAY_NAME} HTTP`;

export type CarrierTrackingEvents = { codes: string[]; descriptions: string[] };
export type CarrierTrackingPollResult = {
  responseText: string;
  events: CarrierTrackingEvents;
  providerError: string | null;
};

export function buildCarrierTrackingEnvelope(trackingNumber: string, username: string, password: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${CARRIER_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <ser:getTrackAndTraceInfo>
      <authData>
        <username>${escapeXml(username)}</username>
        <password>${escapeXml(password)}</password>
      </authData>
      <shipmentId>${escapeXml(trackingNumber)}</shipmentId>
    </ser:getTrackAndTraceInfo>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function extractCarrierTrackingEvents(xml: string): CarrierTrackingEvents {
  return {
    codes: allTagValues(xml, "status"),
    descriptions: allTagValues(xml, "description"),
  };
}

export async function pollCarrierTracking(input: {
  fetchImpl: typeof fetch;
  trackingNumber: string;
  username: string;
  password: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal;
}): Promise<CarrierTrackingPollResult> {
  const response = await callCarrierSoap(
    input.fetchImpl,
    "getTrackAndTraceInfo",
    buildCarrierTrackingEnvelope(input.trackingNumber, input.username, input.password),
    {
      timeoutMs: input.timeoutMs,
      maxBodyBytes: input.maxBodyBytes ?? CARRIER_SOAP_RESPONSE_MAX_BYTES,
      signal: input.signal,
    },
  );
  const responseText = response.text;
  const providerError =
    extractFault(responseText) ??
    (response.ok === false
      ? `${CARRIER_HTTP_ERROR_PREFIX} ${response.status}`
      : null);
  return {
    responseText,
    events: providerError ? { codes: [], descriptions: [] } : extractCarrierTrackingEvents(responseText),
    providerError,
  };
}

function allTagValues(xml: string, name: string): string[] {
  const values: string[] = [];
  const expression = new RegExp(`<${name}[^>]*>([^<]*)<\\/${name}>`, "gi");
  for (let match = expression.exec(xml); match; match = expression.exec(xml)) {
    if (match[1].trim()) values.push(match[1].trim());
  }
  return values;
}
