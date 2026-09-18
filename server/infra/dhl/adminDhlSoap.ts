export const CARRIER_ENDPOINT = "https://dhl24.com.pl/webapi2/provider/service.html?ws=1";
export const CARRIER_NAMESPACE = CARRIER_ENDPOINT;
/** The provider's externally visible name; response and audit text use this exact value. */
export const CARRIER_DISPLAY_NAME = "DHL";
export const CARRIER_PROVIDER_ID = "dhl";
export const CARRIER_PROVIDER_ERROR_CODE = "DHL_PROVIDER";
export const CARRIER_ENV_KEYS = {
  username: "DHL_API_USERNAME",
  password: "DHL_API_PASSWORD",
  accountNumber: "DHL_ACCOUNT_NUMBER",
} as const;
export const CARRIER_TRACKING_URL = "https://www.dhl.com/pl-pl/home/tracking.html?tracking-id=";

export type CarrierAdminAuth = { username: string; password: string; accountNumber?: string };
export type CarrierAddress = {
  name: string;
  postalCode: string;
  city: string;
  street: string;
  houseNumber: string;
  contactPerson: string;
  phone: string;
  email: string;
  country?: string;
};

export function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function cleanPostalCode(value: string): string {
  return value.replace(/-/g, "");
}

export function parseStreet(fullStreet: string): { street: string; houseNumber: string } {
  const trimmed = fullStreet.trim();
  const match = trimmed.match(/^(.+?)\s+(\d+\s*[a-zA-Z]?(?:\s*[/-]\s*\d+\s*[a-zA-Z]?)?)$/);
  if (!match) return { street: trimmed, houseNumber: "" };
  return { street: match[1].trim(), houseNumber: match[2].replace(/\s+/g, "") };
}

export function sanitizeCarrierError(error: unknown): string {
  const result = String(error ?? `${CARRIER_DISPLAY_NAME} request failed`)
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(password|pass|username|login)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (result || `${CARRIER_DISPLAY_NAME} request failed`).slice(0, 300);
}

export async function callCarrierSoap(fetchImpl: typeof fetch, operation: string, body: string) {
  const response = await fetchImpl(CARRIER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `${CARRIER_NAMESPACE}#${operation}`,
    },
    body,
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

function escapedTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractXmlValue(xml: string, tag: string): string | null {
  const name = escapedTag(tag);
  const match = xml.match(new RegExp(
    `<(?:[^:\\s<>/]+:)?${name}\\b[^>]*>([^<]*)<\\/(?:[^:\\s<>/]+:)?${name}>`,
    "i",
  ));
  return match?.[1] ?? null;
}

export function extractXmlArrayValues(xml: string, tag: string): string[] {
  const name = escapedTag(tag);
  const blocks = new RegExp(
    `<(?:[^:\\s<>/]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[^:\\s<>/]+:)?${name}>`,
    "gi",
  );
  const values: string[] = [];
  for (const match of xml.matchAll(blocks)) {
    const content = match[1]?.trim();
    if (!content) continue;
    const items = [...content.matchAll(/<(?:[^:\s<>/]+:)?item\b[^>]*>([^<]*)<\/(?:[^:\s<>/]+:)?item>/gi)]
      .map((item) => item[1]?.trim())
      .filter((value): value is string => Boolean(value));
    if (items.length) values.push(...items);
    else if (!/<(?:[^:\s<>/]+:)?[A-Za-z_][\w.-]*[^>]*>/.test(content)) values.push(content);
  }
  return values;
}

export function extractCarrierPickupOrderId(xml: string): string | null {
  const values = [
    extractXmlValue(xml, "result"),
    extractXmlValue(xml, "orderNumber"),
    extractXmlValue(xml, "bookCourierResult"),
    extractXmlValue(xml, "orderId"),
    ...extractXmlArrayValues(xml, "bookCourierResult"),
    ...extractXmlArrayValues(xml, "orderId"),
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  const unique = [...new Set(values)];
  return unique.length ? unique.join(", ") : null;
}

export function extractFault(xml: string): string | null {
  return extractXmlValue(xml, "faultstring");
}

export function buildCreateShipmentEnvelope(input: {
  auth: CarrierAdminAuth;
  shipper: CarrierAddress;
  receiver: CarrierAddress;
  shipmentDate: string;
}): string {
  const { auth, shipper, receiver, shipmentDate } = input;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${CARRIER_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:createShipments>
      <authData>
        <username>${escapeXml(auth.username)}</username>
        <password>${escapeXml(auth.password)}</password>
      </authData>
      <shipments>
        <item>
        ${shipmentAddress("shipper", shipper)}
        ${shipmentAddress("receiver", receiver)}
        <pieceList><item>
          <type>PACKAGE</type><width>30</width><height>20</height><length>40</length>
          <weight>3</weight><quantity>1</quantity><nonStandard>false</nonStandard>
        </item></pieceList>
        <payment>
          <paymentMethod>BANK_TRANSFER</paymentMethod><payerType>SHIPPER</payerType>
          <accountNumber>${escapeXml(auth.accountNumber ?? "")}</accountNumber>
        </payment>
        <service>
          <product>AH</product><collectOnDelivery>false</collectOnDelivery><insurance>false</insurance>
          <returnOnDelivery>false</returnOnDelivery><proofOfDelivery>false</proofOfDelivery>
          <selfCollect>false</selfCollect><predeliveryInformation>false</predeliveryInformation>
          <deliveryToNeighbour>false</deliveryToNeighbour><preaviso>false</preaviso>
          <deliveryEvening>false</deliveryEvening><deliveryOnSaturday>false</deliveryOnSaturday>
          <pickupOnSaturday>false</pickupOnSaturday>
        </service>
        <shipmentDate>${escapeXml(shipmentDate)}</shipmentDate>
        <content>Karma dla zwierzat</content><comment>OPENLUP tester</comment>
        <skipRestrictionCheck>false</skipRestrictionCheck>
      </item>
      </shipments>
    </tns:createShipments>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function shipmentAddress(tag: "shipper" | "receiver", address: CarrierAddress): string {
  const country = tag === "receiver"
    ? `<country>${escapeXml(address.country ?? DEFAULT_COUNTRY_CODE)}</country>`
    : "";
  const type = tag === "receiver" ? "<addressType>C</addressType>" : "";
  return [
    `<${tag}>`, type, country,
    `<name>${escapeXml(address.name)}</name>`,
    `<postalCode>${escapeXml(cleanPostalCode(address.postalCode))}</postalCode>`,
    `<city>${escapeXml(address.city)}</city>`,
    `<street>${escapeXml(address.street)}</street>`,
    `<houseNumber>${escapeXml(address.houseNumber)}</houseNumber>`,
    `<contactPerson>${escapeXml(address.contactPerson)}</contactPerson>`,
    `<contactPhone>${escapeXml(address.phone)}</contactPhone>`,
    `<contactEmail>${escapeXml(address.email)}</contactEmail>`,
    `</${tag}>`,
  ].join("");
}

export function buildBookCourierEnvelope(input: {
  auth: CarrierAdminAuth;
  pickupDate: string;
  pickupTimeFrom: string;
  pickupTimeTo: string;
  contactPerson: string;
  contactPhone: string;
  additionalInfo: string;
  shipmentIds: string[];
}): string {
  const shipmentItems = input.shipmentIds
    .map((id) => `        <item>${escapeXml(id)}</item>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${CARRIER_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:bookCourier>
      <authData>
        <username>${escapeXml(input.auth.username)}</username>
        <password>${escapeXml(input.auth.password)}</password>
      </authData>
      <pickupDate>${escapeXml(input.pickupDate)}</pickupDate>
      <pickupTimeFrom>${escapeXml(input.pickupTimeFrom)}</pickupTimeFrom>
      <pickupTimeTo>${escapeXml(input.pickupTimeTo)}</pickupTimeTo>
      <contactPerson>${escapeXml(input.contactPerson)}</contactPerson>
      <contactPhone>${escapeXml(input.contactPhone)}</contactPhone>
      <additionalInfo>${escapeXml(input.additionalInfo)}</additionalInfo>
      <shipmentIdList>
${shipmentItems}
      </shipmentIdList>
    </tns:bookCourier>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function buildGetLabelsEnvelope(auth: CarrierAdminAuth, shipmentId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${CARRIER_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:getLabels>
      <authData>
        <username>${escapeXml(auth.username)}</username>
        <password>${escapeXml(auth.password)}</password>
      </authData>
      <itemsToPrint><item>
        <labelType>BLP</labelType><shipmentId>${escapeXml(shipmentId)}</shipmentId>
      </item></itemsToPrint>
    </tns:getLabels>
  </soapenv:Body>
</soapenv:Envelope>`;
}
import { DEFAULT_COUNTRY_CODE } from "./commerceShipmentSoap.js";
