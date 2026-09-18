import type { FulfillmentDhlShipmentPort as ShipmentPort } from "../../../src/domains/fulfillment/ports.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  CARRIER_DISPLAY_NAME,
  CARRIER_ENV_KEYS,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  DhlProviderFault,
  parseStreet,
  sanitizeProviderText,
  type DhlParty,
} from "../../infra/dhl/commerceShipmentSoap.js";
import { sendStatusEmailInProcess } from "./edgeHandlerRuntimeLoader.js";
import { createCarrierShipmentAction } from "./createShipmentAction.js";
import {
  CARRIER_PERSISTENCE,
  CARRIER_LEGACY_PORT_METHOD,
  CARRIER_ROUTE_MESSAGE,
} from "./courierPickupStore.js";

interface LegacyShipmentResponse {
  tracking_number?: string;
  tracking_url?: string;
  label_url?: string | null;
  [CARRIER_PERSISTENCE.shipmentDispatchId]?: string | null;
  [CARRIER_PERSISTENCE.shipmentDate]?: string | null;
  error?: unknown;
}

export interface CommerceDeliveryContactRow {
  id: string;
  order_id: string;
  status: string;
  shipping_address_snapshot?: Record<string, unknown> | null;
  commerce_orders?: { order_number?: string | null } | null;
  clients?: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  } | null;
}

export type CarrierShipmentRuntimeEnv = Record<string, string | undefined> & {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  [CARRIER_ENV_KEYS.username]?: string;
  [CARRIER_ENV_KEYS.password]?: string;
  [CARRIER_ENV_KEYS.accountNumber]?: string;
};

export type CarrierShipmentRunner = (
  request: { accessToken: string | null; testerId: string; skipStatusChange: boolean },
  env?: DhlCreateShipmentRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<{ status: number; body: LegacyShipmentResponse }>;

export type DhlCreateShipmentRuntimeEnv = CarrierShipmentRuntimeEnv;
export type DhlCreateShipmentRunner = CarrierShipmentRunner;

export function createDhlCreateShipmentPort(options: {
  accessToken: string | null;
  env?: CarrierShipmentRuntimeEnv;
  runCreateShipment?: CarrierShipmentRunner;
}): ShipmentPort {
  const runCreateShipment = options.runCreateShipment ?? runCarrierShipment;
  return {
    async [CARRIER_LEGACY_PORT_METHOD.createShipment]({ testerId, skipStatusChange }) {
      const result = await runCreateShipment({
        accessToken: options.accessToken,
        testerId,
        skipStatusChange: Boolean(skipStatusChange),
      }, options.env);
      const data = result.body;
      if (result.status < 200 || result.status >= 300) {
        throw new Error(String(data.error ?? `create_dhl_shipment_http_${result.status}`));
      }
      if (data?.error) throw new Error(String(data.error));
      return mapLegacyShipmentResponse(data ?? {});
    },
    async [CARRIER_LEGACY_PORT_METHOD.label]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.label);
    },
    async [CARRIER_LEGACY_PORT_METHOD.mergeLabels]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.mergeLabels);
    },
    async [CARRIER_LEGACY_PORT_METHOD.bookCourier]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.bookCourier);
    },
    async [CARRIER_LEGACY_PORT_METHOD.repairCourier]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.repairCourier);
    },
    async [CARRIER_LEGACY_PORT_METHOD.clearShipmentState]() {
      throw new Error(CARRIER_ROUTE_MESSAGE.clearShipmentState);
    },
  };
}

const runCarrierShipment: CarrierShipmentRunner = async (
  request,
  env = process.env,
  fetchImpl = fetch,
) => {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }
  if (!env[CARRIER_ENV_KEYS.username] || !env[CARRIER_ENV_KEYS.password] || !env[CARRIER_ENV_KEYS.accountNumber]) {
    return { status: 500, body: { error: "dhl_credentials_not_configured" } };
  }

  try {
    const action = createCarrierShipmentAction({
    client: createServiceRoleClient({ url, serviceRoleKey }) as never,
    fetchImpl,
    auth: {
      username: env[CARRIER_ENV_KEYS.username]!,
      password: env[CARRIER_ENV_KEYS.password]!,
      accountNumber: env[CARRIER_ENV_KEYS.accountNumber]!,
    },
    sendEmail: (testerId, templateSlug, source) =>
      sendStatusEmailInProcess({
        serviceRoleKey,
        testerId,
        templateSlug,
        source,
        env,
        fetchImpl,
      }),
    });
    const result = await action(request);
    return {
      status: 200,
      body: {
        tracking_number: result.trackingNumber,
        tracking_url: result.trackingUrl,
        label_url: result.labelUrl,
        [CARRIER_PERSISTENCE.shipmentDispatchId]: result.shipmentDispatchId,
        [CARRIER_PERSISTENCE.shipmentDate]: result.shipmentDate,
      },
    };
  } catch (error) {
    return { status: error instanceof Error ? 400 : 500, body: { error: error instanceof Error ? error.message : `${CARRIER_DISPLAY_NAME} request failed` } };
  }
};

function mapLegacyShipmentResponse(data: LegacyShipmentResponse) {
  return {
    trackingNumber: data.tracking_number ?? "",
    trackingUrl: data.tracking_url ?? null,
    labelUrl: data.label_url ?? null,
    dhlShipmentId: data[CARRIER_PERSISTENCE.shipmentDispatchId] ?? null,
    dhlShipmentDate: data[CARRIER_PERSISTENCE.shipmentDate] ?? null,
  };
}

export const runDhlCreateShipment = runCarrierShipment;
export const mapLegacyCreateDhlShipmentResponse = mapLegacyShipmentResponse;

export function receiverFromRow(row: CommerceDeliveryContactRow): DhlParty {
  const address = row.shipping_address_snapshot ?? {};
  const client = row.clients ?? {};
  const contactValue = address.deliveryContact;
  if (contactValue !== undefined && contactValue !== null) return canonicalReceiver(contactValue);
  const line1 = text(address.line1);
  const parsed = parseStreet(line1);
  if (!parsed.houseNumber) throw new DhlProviderFault("dhl_receiver_house_number_required", false);
  const email = text(client.email);
  if (!deliverableEmail(email)) throw new DhlProviderFault("dhl_receiver_email_required", false);
  return {
    name: `${text(client.first_name)} ${text(client.last_name)}`.trim() || "OPENLUP Customer",
    street: parsed.street,
    houseNumber: parsed.houseNumber,
    postalCode: text(address.postalCode),
    city: text(address.city),
    country: text(address.country) || "PL",
    phone: text(client.phone),
    email,
  };
}

export function sanitizeFulfillmentContactError(
  error: unknown,
  row: CommerceDeliveryContactRow,
): string {
  let sanitized = sanitizeProviderText(error instanceof Error ? error.message : error);
  const address = row.shipping_address_snapshot ?? {};
  const contact = record(address.deliveryContact);
  const client = row.clients ?? {};
  const values = [
    contact?.recipientName, contact?.contactEmail, contact?.contactPhone, contact?.line1,
    contact?.line2, contact?.city, contact?.postalCode, address.recipientName, address.line1,
    address.line2, address.city, address.postalCode, client.email, client.first_name,
    client.last_name, client.phone,
  ].map(requiredText).filter((item) => item.length >= 3).sort((a, b) => b.length - a.length);
  for (const value of values) sanitized = sanitized.replaceAll(value, "[redacted-contact]");
  return sanitized;
}

export function sanitizedRequestPayload(
  row: CommerceDeliveryContactRow,
  shipmentDate: string,
  source: string,
  providerKind: string,
): Record<string, unknown> {
  const contact = record(row.shipping_address_snapshot?.deliveryContact);
  return {
    source,
    providerKind,
    orderId: row.order_id,
    orderNumber: row.commerce_orders?.order_number ?? null,
    shipmentDate,
    service: "dhl_courier_standard",
    deliveryContactRevision: integer(contact?.revision),
    deliveryContactSource: text(contact?.source) || "legacy_inferred",
  };
}

function canonicalReceiver(value: unknown): DhlParty {
  const contact = record(value);
  const name = requiredText(contact?.recipientName);
  const email = requiredText(contact?.contactEmail);
  const phone = requiredText(contact?.contactPhone);
  const line1 = requiredText(contact?.line1);
  const postalCode = requiredText(contact?.postalCode);
  const city = requiredText(contact?.city);
  const country = requiredText(contact?.country);
  const optionalsValid = [contact?.line2, contact?.deliveryInstructions, contact?.courierInstructions]
    .every((item) => item === null || typeof item === "string");
  const selectionValid = contact?.selectedDelivery === null || record(contact?.selectedDelivery) !== null;
  if (contact?.schemaVersion !== 1 || !Number.isInteger(contact.revision) || Number(contact.revision) <= 0
    || !requiredText(contact.source) || !name || !deliverableEmail(email) || !phone || !line1
    || !postalCode || !city || !country || !optionalsValid || !selectionValid) {
    throw new DhlProviderFault("dhl_delivery_contact_invalid", false);
  }
  const parsed = parseStreet(line1);
  if (!parsed.houseNumber) throw new DhlProviderFault("dhl_receiver_house_number_required", false);
  return { name, street: parsed.street, houseNumber: parsed.houseNumber, postalCode, city, country, phone, email };
}

function deliverableEmail(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") && !normalized.endsWith(".invalid");
}

function requiredText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 1;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
