import { DEFAULT_COUNTRY_CODE } from "./commerceShipmentSoap.js";

export const CARRIER_ENDPOINT = "https://dhl24.com.pl/webapi2/provider/service.html?ws=1";
export const CARRIER_NAMESPACE = CARRIER_ENDPOINT;
export const CARRIER_SOAP_TIMEOUT_MS = 15_000;
export const CARRIER_LABEL_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
export const CARRIER_SOAP_RESPONSE_MAX_BYTES = 512 * 1024;
/** The provider's externally visible name; response and audit text use this exact value. */
export const CARRIER_DISPLAY_NAME = "DHL";
export const CARRIER_PROVIDER_ID = "dhl";
export const CARRIER_LABELS_BUCKET = `${CARRIER_PROVIDER_ID}-labels`;
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

const MAX_SANITIZE_INPUT_CHARS = 4096;

export function sanitizeCarrierError(error: unknown): string {
  const bounded = String(error ?? `${CARRIER_DISPLAY_NAME} request failed`).slice(0, MAX_SANITIZE_INPUT_CHARS);
  const result = bounded
    .replace(
      /<((?:[^:\s<>/]+:)?(?:authData|password|pass|username|login|token|secret|apiKey|accountNumber))\b[^>]*>[\s\S]*?<\/\1>/gi,
      "$1: [redacted]",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\bauthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?\S+/gi, "authorization: [redacted]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/(?:^|[\s,;(])([a-z0-9_-]*(?:password|pass|username|login|token|secret|api[_-]?key))\s*[:=]\s*\S+/gi, " $1: [redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(?:\+\d{1,3}[\s.-]?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3}[\s.-]\d{3,4}|\(\d{2,4}\)[\s.-]?\d{3}[\s.-]\d{3,4})/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .trim();
  return (result || `${CARRIER_DISPLAY_NAME} request failed`).slice(0, 300);
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function safeObjectKey(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  if (hasControlChar(value)) return false;
  if (value.split("/").some((segment) => segment.length === 0 || segment.startsWith(".") || /\s/.test(segment))) {
    return false;
  }
  return true;
}

export function safeTrackingLabelObjectKey(trackingNumber: string): string | null {
  if (
    trackingNumber.length === 0 ||
    trackingNumber.trim() !== trackingNumber ||
    trackingNumber.includes("/") ||
    trackingNumber.includes("\\") ||
    trackingNumber.startsWith(".")
  ) {
    return null;
  }
  const key = `${trackingNumber}.pdf`;
  return safeObjectKey(key) ? key : null;
}

export function privateLabelObjectKey(value: string): string | null {
  if (value.trim() !== value || value.length === 0) return null;
  if (!/^https?:\/\//i.test(value)) return safeObjectKey(value) ? value : null;
  try {
    const path = new URL(value).pathname;
    const match = path.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
    if (!match || match[1] !== CARRIER_LABELS_BUCKET) return null;
    const objectKey = decodeURIComponent(match[2]);
    return safeObjectKey(objectKey) ? objectKey : null;
  } catch {
    return null;
  }
}

export type CallCarrierSoapOptions = {
  timeoutMs?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal;
};

export class CarrierSoapResponseTooLargeError extends Error {
  constructor(public readonly maxBodyBytes: number) {
    super(`${CARRIER_DISPLAY_NAME} SOAP response exceeded ${maxBodyBytes} bytes`);
    this.name = "CarrierSoapResponseTooLargeError";
  }
}

export async function callCarrierSoap(
  fetchImpl: typeof fetch,
  operation: string,
  body: string,
  options: CallCarrierSoapOptions = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const timeoutMs = options.timeoutMs ?? CARRIER_SOAP_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? CARRIER_LABEL_RESPONSE_MAX_BYTES;
  const timeoutController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  if (options.signal?.aborted) {
    throw toAbortError(options.signal.reason);
  }
  if (timeoutMs <= 0) {
    const error = new Error(`${CARRIER_DISPLAY_NAME} SOAP request timed out after ${timeoutMs}ms`);
    timeoutController.abort(error);
    throw error;
  }

  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`${CARRIER_DISPLAY_NAME} SOAP request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await raceWithAbort(
      fetchImpl(CARRIER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `${CARRIER_NAMESPACE}#${operation}`,
        },
        body,
        redirect: "manual",
        signal,
      }),
      signal,
    );
    const text = await readBoundedResponseText(response, maxBodyBytes, signal);
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  return new Error(`${CARRIER_DISPLAY_NAME} SOAP request aborted`);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLengthHeader = response.headers?.get?.("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      await response.body?.cancel().catch(() => {});
      throw new CarrierSoapResponseTooLargeError(maxBodyBytes);
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) {
          await reader.cancel(signal.reason).catch(() => {});
          throw toAbortError(signal.reason);
        }
        const chunk = await raceWithAbort(reader.read(), signal);
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxBodyBytes) {
          await reader.cancel().catch(() => {});
          throw new CarrierSoapResponseTooLargeError(maxBodyBytes);
        }
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        // Ignore if stream is already closed or errored.
      }
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  const text = await raceWithAbort(response.text(), signal);
  if (Buffer.byteLength(text, "utf8") > maxBodyBytes) {
    throw new CarrierSoapResponseTooLargeError(maxBodyBytes);
  }
  return text;
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
