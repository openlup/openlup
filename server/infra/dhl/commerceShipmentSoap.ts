export const DHL_ENDPOINT = "https://dhl24.com.pl/webapi2/provider/service.html?ws=1";
export const DHL_NAMESPACE = "https://dhl24.com.pl/webapi2/provider/service.html?ws=1";
export const DEFAULT_COUNTRY_CODE = "PL";
export const WARSAW_TIME_ZONE = "Europe/Warsaw";

export interface DhlAuthConfig {
  username: string;
  password: string;
  accountNumber: string;
}

export interface DhlParty {
  name: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country?: string;
  phone: string;
  email: string;
  contactPerson?: string;
}

export interface DhlShipmentResult {
  trackingNumber: string;
  dispatchId: string | null;
  shipmentDate: string;
  labelPdf: Uint8Array | null;
}

export interface DhlSoapCallDeps {
  auth: DhlAuthConfig;
  shipper: DhlParty;
  receiver: DhlParty;
  shipmentDate: string;
  fetchImpl?: typeof fetch;
  decodeBase64?: (value: string) => Uint8Array;
}

export async function createDhlShipmentWithLabel({
  auth,
  shipper,
  receiver,
  shipmentDate,
  fetchImpl = fetch,
  decodeBase64 = defaultDecodeBase64,
}: DhlSoapCallDeps): Promise<DhlShipmentResult> {
  const createXml = buildCreateShipmentsEnvelope(shipper, receiver, auth, shipmentDate);
  const createResponse = await callDhl(fetchImpl, `${DHL_NAMESPACE}#createShipments`, createXml);
  const trackingNumber =
    extractXmlValue(createResponse, "shipmentId") ??
    extractXmlValue(createResponse, "shipmentTrackingNumber");
  if (!trackingNumber) {
    throw new DhlProviderFault(sanitizeProviderText(
      extractXmlValue(createResponse, "value") ??
      extractXmlValue(createResponse, "message") ??
      "DHL createShipments response missing tracking number",
    ), false);
  }

  let labelPdf: Uint8Array | null = null;
  const labelXml = buildGetLabelsEnvelope(auth, trackingNumber);
  const labelResponse = await callDhl(fetchImpl, `${DHL_NAMESPACE}#getLabels`, labelXml);
  const labelData = extractXmlValue(labelResponse, "labelData");
  if (labelData) labelPdf = decodeBase64(labelData);

  return {
    trackingNumber,
    dispatchId: extractXmlValue(createResponse, "dispatchIdentificationNumber") ?? trackingNumber,
    shipmentDate,
    labelPdf,
  };
}

export class DhlProviderFault extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "DhlProviderFault";
  }
}

async function callDhl(fetchImpl: typeof fetch, soapAction: string, body: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(DHL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: soapAction,
      },
      body,
    });
  } catch (error) {
    throw new DhlProviderFault(sanitizeProviderText(error), true);
  }
  const text = await response.text();
  const fault = extractFault(text);
  if (fault) throw new DhlProviderFault(sanitizeProviderText(fault), false);
  if (text.includes("<h1>CException</h1>") || text.includes("<html")) {
    throw new DhlProviderFault(sanitizeProviderText(text.match(/<p>(.*?)<\/p>/)?.[1] ?? "DHL returned HTML error"), !response.ok || response.status >= 500);
  }
  if (!response.ok) {
    throw new DhlProviderFault(`DHL HTTP ${response.status}`, response.status >= 500);
  }
  return text;
}

export function parseStreet(fullStreet: string): { street: string; houseNumber: string } {
  const trimmed = fullStreet.trim();
  const match = trimmed.match(/^(.+?)\s+(\d+\s*[a-zA-Z]?(?:\s*[/-]\s*\d+\s*[a-zA-Z]?)?)$/);
  if (!match) return { street: trimmed, houseNumber: "" };
  return { street: match[1].trim(), houseNumber: match[2].replace(/\s+/g, "") };
}

export function nextWarsawBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const date = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 2);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function sanitizeProviderText(value: unknown): string {
  const stripped = String(value ?? "DHL request failed")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(password|pass|username|login)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(?:\+?\d[\d\s()./-]{7,}\d)/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .trim();
  return (stripped || "DHL request failed").slice(0, 300);
}

function buildCreateShipmentsEnvelope(
  shipper: DhlParty,
  receiver: DhlParty,
  auth: DhlAuthConfig,
  shipmentDate: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${DHL_NAMESPACE}">
  <soapenv:Header/><soapenv:Body><tns:createShipments><authData>
    <username>${escapeXml(auth.username)}</username><password>${escapeXml(auth.password)}</password>
  </authData><shipments><item>
    <shipper>${partyXml(shipper, false)}</shipper>
    <receiver><addressType>C</addressType>${partyXml(receiver, true)}</receiver>
    <pieceList><item><type>PACKAGE</type><width>30</width><height>20</height><length>40</length><weight>3</weight><quantity>1</quantity><nonStandard>false</nonStandard></item></pieceList>
    <payment><paymentMethod>BANK_TRANSFER</paymentMethod><payerType>SHIPPER</payerType><accountNumber>${escapeXml(auth.accountNumber)}</accountNumber></payment>
    <service><product>AH</product><collectOnDelivery>false</collectOnDelivery><insurance>false</insurance><returnOnDelivery>false</returnOnDelivery><proofOfDelivery>false</proofOfDelivery><selfCollect>false</selfCollect><predeliveryInformation>false</predeliveryInformation><deliveryToNeighbour>false</deliveryToNeighbour><preaviso>false</preaviso><deliveryEvening>false</deliveryEvening><deliveryOnSaturday>false</deliveryOnSaturday><pickupOnSaturday>false</pickupOnSaturday></service>
    <shipmentDate>${escapeXml(shipmentDate)}</shipmentDate><content>Karma dla zwierzat</content><comment>OPENLUP commerce</comment><skipRestrictionCheck>false</skipRestrictionCheck>
  </item></shipments></tns:createShipments></soapenv:Body>
</soapenv:Envelope>`;
}

function buildGetLabelsEnvelope(auth: DhlAuthConfig, trackingNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${DHL_NAMESPACE}">
  <soapenv:Header/><soapenv:Body><tns:getLabels><authData>
    <username>${escapeXml(auth.username)}</username><password>${escapeXml(auth.password)}</password>
  </authData><itemsToPrint><item><labelType>BLP</labelType><shipmentId>${escapeXml(trackingNumber)}</shipmentId></item></itemsToPrint></tns:getLabels></soapenv:Body>
</soapenv:Envelope>`;
}

function partyXml(party: DhlParty, includeCountry: boolean): string {
  return `${includeCountry ? `<country>${escapeXml(party.country ?? DEFAULT_COUNTRY_CODE)}</country>` : ""}
    <name>${escapeXml(party.name)}</name><postalCode>${escapeXml(cleanPostalCode(party.postalCode))}</postalCode>
    <city>${escapeXml(party.city)}</city><street>${escapeXml(party.street)}</street><houseNumber>${escapeXml(party.houseNumber)}</houseNumber>
    <contactPerson>${escapeXml(party.contactPerson ?? party.name)}</contactPerson><contactPhone>${escapeXml(party.phone)}</contactPhone><contactEmail>${escapeXml(party.email)}</contactEmail>`;
}

function extractFault(xml: string): string | null {
  return extractXmlValue(xml, "faultstring");
}

function extractXmlValue(xml: string, tagName: string): string | null {
  const nsMatch = xml.match(new RegExp(`<[^:]+:${tagName}[^>]*>([^<]*)<\\/[^:]+:${tagName}>`, "i"));
  if (nsMatch) return nsMatch[1];
  return xml.match(new RegExp(`<${tagName}[^>]*>([^<]*)<\\/${tagName}>`, "i"))?.[1] ?? null;
}

function cleanPostalCode(code: string): string {
  return (code ?? "").replace(/-/g, "");
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function defaultDecodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
