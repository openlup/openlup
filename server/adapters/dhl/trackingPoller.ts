import {
  CARRIER_DISPLAY_NAME,
  CARRIER_NAMESPACE,
  escapeXml,
} from "../../infra/dhl/adminDhlSoap.js";

export { CARRIER_NAMESPACE as CARRIER_TRACKING_ENDPOINT };
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
}): Promise<CarrierTrackingPollResult> {
  const response = await input.fetchImpl(CARRIER_NAMESPACE, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `${CARRIER_NAMESPACE}#getTrackAndTraceInfo`,
    },
    body: buildCarrierTrackingEnvelope(input.trackingNumber, input.username, input.password),
  });
  const responseText = await response.text();
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

function extractFault(xml: string): string | null {
  return xml.match(/<faultstring[^>]*>([^<]*)<\/faultstring>/i)?.[1] ?? null;
}
