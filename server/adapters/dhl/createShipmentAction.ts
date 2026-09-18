/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query client is structural at this boundary. */
import { randomUUID } from "node:crypto";
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import {
  buildCreateShipmentEnvelope,
  buildGetLabelsEnvelope,
  CARRIER_DISPLAY_NAME,
  CARRIER_TRACKING_URL,
  callCarrierSoap,
  extractFault,
  extractXmlValue,
  parseStreet,
  sanitizeCarrierError,
  type CarrierAdminAuth,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  DEFAULT_COUNTRY_CODE,
  nextWarsawBusinessDate,
} from "../../infra/dhl/commerceShipmentSoap.js";
import {
  CARRIER_PERSISTENCE,
  CARRIER_SHIPPER_SETTING,
} from "./courierPickupStore.js";

type Client = {
  auth: { getUser: (token: string) => Promise<any> };
  from: (table: string) => any;
  storage: { from: (bucket: string) => any };
};

type Input = { accessToken: string | null; testerId: string; skipStatusChange: boolean };
type Output = {
  trackingNumber: string;
  trackingUrl: string;
  labelUrl: string | null;
  shipmentDispatchId: string;
  shipmentDate: string;
};

export function createCarrierShipmentAction(deps: {
  client: Client;
  fetchImpl: typeof fetch;
  auth: CarrierAdminAuth;
  now?: () => string;
  nextShipmentDate?: () => string;
  decodeBase64?: (value: string) => Uint8Array;
  objectKey?: (testerId: string) => string;
  sendEmail?: (id: string, slug: string, source: string) => Promise<unknown>;
  log?: (...args: unknown[]) => void;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const nextShipmentDate = deps.nextShipmentDate ?? nextWarsawBusinessDate;
  const decodeBase64 = deps.decodeBase64 ?? ((value) => Uint8Array.from(Buffer.from(value, "base64")));
  const objectKey = deps.objectKey ?? ((testerId) => `${testerId}/${randomUUID()}.pdf`);
  const log = deps.log ?? (() => undefined);
  return async (input: Input): Promise<Output> => {
    await assertAdmin(deps.client, input.accessToken);
    if (!input.testerId) throw new FulfillmentPreflightError("Brak tester_id");
    const { data: tester, error } = await deps.client.from("testers").select("*").eq("id", input.testerId).single();
    if (error || !tester) throw new FulfillmentPreflightError(`Tester nie znaleziony: ${error?.message}`);
    if (tester.tracking_number) throw new FulfillmentPreflightError("Przesyłka już istnieje dla tego testera");
    const receiver = makeReceiver(tester);
    const shipper = await loadShipper(deps.client);
    const shipmentDate = nextShipmentDate();
    const response = await createShipment(deps.fetchImpl, deps.auth, shipper, receiver, shipmentDate);
    const labelUrl = await persistLabel({
      client: deps.client,
      fetchImpl: deps.fetchImpl,
      auth: deps.auth,
      testerId: input.testerId,
      trackingNumber: response.trackingNumber,
      decodeBase64,
      objectKey,
      log,
    });
    const trackingUrl = carrierTrackingUrl(response.trackingNumber);
    const shipmentDispatchId = response.dispatchId || response.trackingNumber;
    const update = {
      tracking_number: response.trackingNumber,
      tracking_url: trackingUrl,
      [CARRIER_PERSISTENCE.shipmentDispatchId]: shipmentDispatchId,
      [CARRIER_PERSISTENCE.shipmentDate]: shipmentDate,
      label_url: labelUrl,
      ...(!input.skipStatusChange ? { status: "shipped", status_updated_at: now() } : {}),
    };
    const updateResult = await deps.client.from("testers").update(update).eq("id", input.testerId);
    if (updateResult.error) log(`[${CARRIER_DISPLAY_NAME}] Update error:`, updateResult.error.message);
    if (!input.skipStatusChange) {
      try { await deps.sendEmail?.(input.testerId, "shipped", CARRIER_PERSISTENCE.shipmentEmailSource); }
      catch (cause) { log(`[${CARRIER_DISPLAY_NAME}] Email error:`, cause); }
    }
    return {
      trackingNumber: response.trackingNumber,
      trackingUrl,
      labelUrl,
      shipmentDispatchId,
      shipmentDate,
    };
  };
}

export function carrierTrackingUrl(trackingNumber: string): string {
  return `${CARRIER_TRACKING_URL}${trackingNumber}`;
}

async function assertAdmin(client: Client, accessToken: string | null) {
  if (!accessToken) throw new FulfillmentPreflightError("Brak tokenu autoryzacji");
  const user = await client.auth.getUser(accessToken);
  if (user.error || !user.data?.user) throw new FulfillmentPreflightError(`Auth error: ${user.error?.message || "no user"}`);
  const { data: admin } = await client.from("admin_users").select("id").eq("id", user.data.user.id).maybeSingle();
  if (!admin) throw new FulfillmentPreflightError("Nie jesteś adminem");
}

function makeReceiver(tester: any) {
  const address = parseStreet(String(tester.street ?? ""));
  if (!address.houseNumber) {
    throw new FulfillmentPreflightError(
      `Brak numeru budynku w adresie "${tester.street}". Popraw adres testera i spróbuj ponownie.`,
    );
  }
  const name = `${tester.first_name} ${tester.last_name}`;
  return {
    name,
    street: address.street,
    houseNumber: address.houseNumber,
    postalCode: tester.postal_code,
    city: tester.city,
    country: tester.country === "Polska" ? DEFAULT_COUNTRY_CODE : (tester.country || DEFAULT_COUNTRY_CODE),
    contactPerson: name,
    phone: tester.phone,
    email: tester.email,
  };
}

async function loadShipper(client: Client) {
  const { data: rows } = await client.from("settings")
    .select("key, value")
    .like("key", CARRIER_SHIPPER_SETTING.matchingKey);
  const settings: Record<string, string> = {};
  for (const row of rows ?? []) {
    try {
      settings[row.key] = typeof row.value === "string" ? JSON.parse(row.value) : String(row.value);
    } catch {
      settings[row.key] = String(row.value);
    }
  }
  return {
    name: settings[CARRIER_SHIPPER_SETTING.name] || "Example Company Sp. z o.o.",
    street: settings[CARRIER_SHIPPER_SETTING.street] || "Example Street",
    houseNumber: settings[CARRIER_SHIPPER_SETTING.houseNumber] || "11",
    postalCode: settings[CARRIER_SHIPPER_SETTING.postalCode] || "32091",
    city: settings[CARRIER_SHIPPER_SETTING.city] || "Example City",
    contactPerson: settings[CARRIER_SHIPPER_SETTING.contactPerson] || "",
    phone: settings[CARRIER_SHIPPER_SETTING.phone] || "",
    email: settings[CARRIER_SHIPPER_SETTING.email] || "hello@openlup.com",
  };
}

async function createShipment(
  fetchImpl: typeof fetch,
  auth: CarrierAdminAuth,
  shipper: any,
  receiver: any,
  shipmentDate: string,
) {
  let response: Awaited<ReturnType<typeof callCarrierSoap>>;
  try {
    response = await callCarrierSoap(
      fetchImpl,
      "createShipments",
      buildCreateShipmentEnvelope({ auth, shipper, receiver, shipmentDate }),
    );
  } catch (cause) {
    throw new FulfillmentProviderError(`${CARRIER_DISPLAY_NAME} connection error: ${sanitizeCarrierError(cause)}`);
  }
  const fault = extractFault(response.text);
  const cException = response.text.includes("<h1>CException</h1>")
    ? response.text.match(/<p>(.*?)<\/p>/)?.[1]
    : null;
  if (fault) throw new FulfillmentProviderError(`${CARRIER_DISPLAY_NAME} SOAP fault: ${sanitizeCarrierError(fault)}`);
  if (cException || response.text.includes("<html")) {
    throw new FulfillmentProviderError(
      `${CARRIER_DISPLAY_NAME} error: ${sanitizeCarrierError(cException ?? `${CARRIER_DISPLAY_NAME} zwrócił stronę błędu`)}`,
    );
  }
  if (!response.ok) throw new FulfillmentProviderError(`${CARRIER_DISPLAY_NAME} HTTP ${response.status}`);
  const trackingNumber = extractXmlValue(response.text, "shipmentId")
    ?? extractXmlValue(response.text, "shipmentTrackingNumber");
  if (!trackingNumber) {
    throw new FulfillmentProviderError(sanitizeCarrierError(
      extractXmlValue(response.text, "value")
        ?? extractXmlValue(response.text, "message")
        ?? `Brak tracking number w odpowiedzi ${CARRIER_DISPLAY_NAME}`,
    ));
  }
  return { trackingNumber, dispatchId: extractXmlValue(response.text, "dispatchIdentificationNumber") };
}

async function persistLabel(input: {
  client: Client;
  fetchImpl: typeof fetch;
  auth: CarrierAdminAuth;
  testerId: string;
  trackingNumber: string;
  decodeBase64: (value: string) => Uint8Array;
  objectKey: (testerId: string) => string;
  log: (...args: unknown[]) => void;
}): Promise<string | null> {
  try {
    const response = await callCarrierSoap(
      input.fetchImpl,
      "getLabels",
      buildGetLabelsEnvelope(input.auth, input.trackingNumber),
    );
    const labelData = extractXmlValue(response.text, "labelData");
    if (!labelData) return null;
    const key = input.objectKey(input.testerId);
    const upload = await input.client.storage.from(CARRIER_PERSISTENCE.labelBucket).upload(
      key,
      input.decodeBase64(labelData),
      { contentType: "application/pdf", upsert: true },
    );
    if (!upload.error) return key;
    input.log(`[${CARRIER_DISPLAY_NAME}] Label upload error:`, upload.error.message);
  } catch (cause) {
    input.log(`[${CARRIER_DISPLAY_NAME}] Label fetch exception:`, cause);
  }
  return null;
}
