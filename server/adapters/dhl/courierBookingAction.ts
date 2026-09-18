/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query client is structural at this boundary. */
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import {
  buildBookCourierEnvelope,
  callCarrierSoap,
  CARRIER_DISPLAY_NAME,
  extractCarrierPickupOrderId,
  extractFault,
  sanitizeCarrierError,
  type CarrierAdminAuth,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  findCourierPickup,
  loadCarrierShipperContact,
  CARRIER_PERSISTENCE,
  createCarrierProviderEvidence,
  formatCarrierPickupBooking,
  makeCourierPickupEvidenceFromRequest,
  makePickupIdempotencyKey,
  normalizeCarrierPickupIds,
  reconcileShippedTesters,
  recordCourierPickup,
  type CourierPickupTester,
  validateCarrierPickupTesters,
  validateCarrierPickupWindow,
} from "./courierPickupStore.js";
type Client = { auth: { getUser: (token: string) => Promise<any> }; from: (table: string) => any };

export type BookCourierInput = {
  accessToken: string | null;
  pickupDate: string;
  pickupTimeFrom: string;
  pickupTimeTo: string;
  additionalInfo: string;
  testerIds: string[];
};

export type BookCourierOutput = {
  pickupDate: string;
  pickupTime: string;
  shipmentsCount: number;
  courierOrderId: string | null;
};

export function createCarrierPickupBookingAction(deps: {
  client: Client;
  fetchImpl: typeof fetch;
  auth: CarrierAdminAuth;
  now?: () => string;
  sendEmail?: (id: string, slug: string, source: string) => Promise<unknown>;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  return async (input: BookCourierInput): Promise<BookCourierOutput> => {
    const requestedBy = await authenticatedAdmin(deps.client, input.accessToken);
    const testerIds = validateInput(input, now());
    const testers = await loadTesters(deps.client, testerIds);
    const idempotencyKey = makePickupIdempotencyKey(
      testerIds,
      input.pickupDate,
      input.pickupTimeFrom,
      input.pickupTimeTo,
    );
    const existing = await findCourierPickup(deps.client, idempotencyKey);
    if (existing) {
      return reconcileExisting({
        client: deps.client,
        existing,
        input,
        testerIds,
        testers,
        idempotencyKey,
        requestedBy,
        timestamp: now(),
        sendEmail: deps.sendEmail,
      });
    }

    const shipper = await loadShipperContact(deps.client);
    const soap = buildBookCourierEnvelope({
      auth: deps.auth,
      pickupDate: input.pickupDate,
      pickupTimeFrom: input.pickupTimeFrom,
      pickupTimeTo: input.pickupTimeTo,
      contactPerson: shipper.contactPerson,
      contactPhone: shipper.contactPhone,
      additionalInfo: input.additionalInfo,
      shipmentIds: testers.map((tester) => tester[CARRIER_PERSISTENCE.shipmentDispatchId] ?? ""),
    });

    let response: Awaited<ReturnType<typeof callCarrierSoap>>;
    try {
      response = await callCarrierSoap(deps.fetchImpl, "bookCourier", soap);
    } catch (cause) {
      throw await recordProviderFailure({
        client: deps.client,
        input,
        testers,
        idempotencyKey,
        requestedBy,
        timestamp: now(),
        message: sanitizeCarrierError(cause),
        rawResponse: "",
        status: "failed",
      });
    }

    const fault = extractFault(response.text);
    if (fault) {
      throw await recordProviderFailure({
        client: deps.client,
        input,
        testers,
        idempotencyKey,
        requestedBy,
        timestamp: now(),
        message: fault,
        rawResponse: response.text,
        status: "failed",
      });
    }

    const cException = response.text.includes("<h1>CException</h1>")
      ? response.text.match(/<p>(.*?)<\/p>/)?.[1] ?? "Server error"
      : null;
    if (cException) {
      throw await recordProviderFailure({
        client: deps.client,
        input,
        testers,
        idempotencyKey,
        requestedBy,
        timestamp: now(),
        message: cException,
        rawResponse: response.text,
        status: "failed",
      });
    }

    const courierOrderId = extractCarrierPickupOrderId(response.text);
    if (!courierOrderId) {
      throw await recordProviderFailure({
        client: deps.client,
        input,
        testers,
        idempotencyKey,
        requestedBy,
        timestamp: now(),
        message: `${CARRIER_DISPLAY_NAME} nie zwrócił numeru zamówienia kuriera`,
        rawResponse: response.text,
        status: "indeterminate",
      });
    }

    await recordCourierPickup(deps.client, makeCourierPickupEvidenceFromRequest({
      status: "succeeded",
      request: input,
      testers,
      idempotencyKey,
      requestedBy,
      courierOrderId,
      rawResponse: response.text,
    }));
    await throwForFailedReconcile(deps.client, testers, now(), deps.sendEmail, `${CARRIER_DISPLAY_NAME} zwrócił numer zamówienia kuriera`);
    return formatCarrierPickupBooking({ ...input, shipmentsCount: testers.length, courierOrderId });
  };
}

async function authenticatedAdmin(client: Client, accessToken: string | null): Promise<string> {
  if (!accessToken) throw new FulfillmentPreflightError("Brak tokenu autoryzacji");
  const user = await client.auth.getUser(accessToken);
  if (user.error || !user.data?.user) {
    throw new FulfillmentPreflightError(`Auth error: ${user.error?.message || "no user"}`);
  }
  const { data: admin } = await client.from("admin_users")
    .select("id")
    .eq("id", user.data.user.id)
    .maybeSingle();
  if (!admin) throw new FulfillmentPreflightError("Nie jesteś adminem");
  return user.data.user.id;
}

function validateInput(input: BookCourierInput, timestamp: string): string[] {
  const { ids, error } = normalizeCarrierPickupIds(input.pickupDate, input.testerIds);
  if (error) throw new FulfillmentPreflightError(error);
  const issue = validateCarrierPickupWindow(input.pickupDate, input.pickupTimeFrom, input.pickupTimeTo, timestamp);
  if (issue) throw new FulfillmentPreflightError(issue);
  return ids;
}

async function loadTesters(client: Client, ids: string[]): Promise<CourierPickupTester[]> {
  const { data, error } = await client.from("testers")
    .select(CARRIER_PERSISTENCE.testerSelection)
    .in("id", ids);
  if (error || !data) throw new FulfillmentPreflightError("Brak testerów z etykietami do zamówienia kuriera");
  const testers = data as CourierPickupTester[];
  const issue = validateCarrierPickupTesters(testers, ids);
  if (issue) throw new FulfillmentPreflightError(issue);
  return testers;
}

async function loadShipperContact(client: Client): Promise<{ contactPerson: string; contactPhone: string }> {
  const { contactPerson, contactPhone } = await loadCarrierShipperContact(client);
  if (!contactPerson || !contactPhone) {
    throw new FulfillmentPreflightError(`Brak osoby kontaktowej lub telefonu nadawcy ${CARRIER_DISPLAY_NAME}`, {
      errorCode: "INVALID_SHIPPER_CONTACT",
    });
  }
  return { contactPerson, contactPhone };
}

async function reconcileExisting(input: {
  client: Client;
  existing: Awaited<ReturnType<typeof findCourierPickup>> & {};
  input: BookCourierInput;
  testerIds: string[];
  testers: CourierPickupTester[];
  idempotencyKey: string;
  requestedBy: string;
  timestamp: string;
  sendEmail?: (id: string, slug: string, source: string) => Promise<unknown>;
}): Promise<BookCourierOutput> {
  const existing = input.existing!;
  let courierOrderId = existing.courierOrderId;
  if (existing.status === "indeterminate") {
    courierOrderId = existing.rawResponseExcerpt
      ? extractCarrierPickupOrderId(existing.rawResponseExcerpt)
      : null;
    if (!courierOrderId) {
      throw new FulfillmentProviderError(existing.operatorMessage ?? `Poprzednia próba ${CARRIER_DISPLAY_NAME} ma niejednoznaczny wynik`, {
        retryable: false,
        supportCode: existing.supportCode,
      });
    }
    await recordCourierPickup(input.client, makeCourierPickupEvidenceFromRequest({
      status: "succeeded",
      request: input.input,
      testers: input.testers,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy,
      courierOrderId,
      rawResponse: existing.rawResponseExcerpt ?? undefined,
    }));
  }
  await throwForFailedReconcile(input.client, input.testers, input.timestamp, input.sendEmail, `Kurier ${CARRIER_DISPLAY_NAME} jest już zamówiony`);
  return formatCarrierPickupBooking({ ...input.input, shipmentsCount: existing.shipmentsCount || input.testers.length, courierOrderId });
}

async function recordProviderFailure(input: {
  client: Client;
  input: BookCourierInput;
  testers: CourierPickupTester[];
  idempotencyKey: string;
  requestedBy: string;
  timestamp: string;
  message: unknown;
  rawResponse: string;
  status: "failed" | "indeterminate";
}): Promise<FulfillmentProviderError> {
  const provider = createCarrierProviderEvidence(
    sanitizeCarrierError(input.message),
    input.timestamp,
    input.status === "failed",
  );
  await recordCourierPickup(input.client, makeCourierPickupEvidenceFromRequest({
    status: input.status,
    request: input.input,
    testers: input.testers,
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
    rawResponse: input.rawResponse,
    operatorMessage: provider.operatorMessage,
    retryable: provider.retryable,
    supportCode: provider.supportCode,
  }));
  return new FulfillmentProviderError(provider.message, provider);
}

async function throwForFailedReconcile(
  client: Client,
  testers: CourierPickupTester[],
  timestamp: string,
  sendEmail: ((id: string, slug: string, source: string) => Promise<unknown>) | undefined,
  context: string,
) {
  const failed = await reconcileShippedTesters(client, testers, timestamp, sendEmail);
  if (failed.length) {
    throw new FulfillmentPreflightError(
      `${context}, ale nie udało się zaktualizować statusu paczek: ${failed.join(", ")}`,
      { errorCode: "LOCAL_STATUS_UPDATE_FAILED", failedTesterIds: failed },
    );
  }
}
