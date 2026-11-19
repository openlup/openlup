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
  extractXmlValue,
  sanitizeCarrierError,
  type CarrierAdminAuth,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  classifyCarrierProviderMessage,
  loadCarrierShipperContact,
  CARRIER_PERSISTENCE,
  createCarrierProviderEvidence,
  formatCarrierPickupBooking,
  makePickupIdempotencyKey,
  normalizeCarrierPickupIds,
  reconcileShippedTesters,
  type CourierPickupTester,
  validateCarrierPickupTesters,
  validateCarrierPickupWindow,
} from "./courierPickupStore.js";
import {
  claimCourierPickup,
  findCourierPickup,
  recordCourierPickup,
  recordCourierPickupShipments,
  type StoredCourierPickup,
} from "./courierPickupEvidence.js";
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
    const idempotencyKey = makePickupIdempotencyKey(
      testerIds,
      input.pickupDate,
      input.pickupTimeFrom,
      input.pickupTimeTo,
    );
    const existing = await findCourierPickup(deps.client, idempotencyKey);
    const replay = existing?.status === "succeeded" || existing?.status === "indeterminate";
    if (existing && !replay && !canRetryPickup(existing)) throw unresolvedPickup(existing);
    const testers = await loadTesters(deps.client, testerIds, replay);
    if (existing && replay) {
      return reconcileExisting({
        client: deps.client,
        existing,
        input,
        testers,
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

    // Keep the pending row if a process stops or a write is ambiguous. Only a
    // confirmed provider refusal permits taking this key for another attempt.
    const pickupId = await claimCourierPickup(deps.client, {
      idempotencyKey, request: input, requestedBy, testers, retryOf: existing,
    });
    if (!pickupId) throw unresolvedPickup();
    await recordCourierPickupShipments(deps.client, pickupId, testers);

    let response: Awaited<ReturnType<typeof callCarrierSoap>>;
    try {
      response = await callCarrierSoap(deps.fetchImpl, "bookCourier", soap);
    } catch (cause) {
      throw await recordProviderFailure(deps.client, pickupId, now(), sanitizeCarrierError(cause), "", "indeterminate");
    }

    const fault = extractFault(response.text);
    const cException = response.text.includes("<h1>CException</h1>")
      ? response.text.match(/<p>(.*?)<\/p>/)?.[1] ?? "Server error"
      : null;
    const courierOrderId = extractCarrierPickupOrderId(response.text);
    if (fault || cException || !courierOrderId) {
      const confirmedRefusal = fault && !cException && !courierOrderId
        && (classifyCarrierProviderMessage(fault) || isClientFault(response.text));
      const status = confirmedRefusal ? "failed" : "indeterminate";
      const message = fault ?? cException ?? `${CARRIER_DISPLAY_NAME} nie zwrócił numeru zamówienia kuriera`;
      throw await recordProviderFailure(deps.client, pickupId, now(), message, response.text, status);
    }

    if (!await recordCourierPickup(deps.client, pickupId, "pending", {
      status: "succeeded", courierOrderId, rawResponse: response.text,
    })) throw unresolvedPickup({ id: pickupId, courierOrderId });
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

async function loadTesters(client: Client, ids: string[], allowShipped: boolean): Promise<CourierPickupTester[]> {
  const { data, error } = await client.from("testers")
    .select(CARRIER_PERSISTENCE.testerSelection)
    .in("id", ids);
  if (error || !data) throw new FulfillmentPreflightError("Brak testerów z etykietami do zamówienia kuriera");
  const testers = data as CourierPickupTester[];
  const issue = validateCarrierPickupTesters(testers, ids, allowShipped);
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

function canRetryPickup(existing: StoredCourierPickup): boolean {
  // Older failures also included timeouts. Retry only with a stored carrier fault.
  return existing.status === "failed" && existing.retryable && !existing.courierOrderId
    && Boolean(existing.rawResponseExcerpt && isClientFault(existing.rawResponseExcerpt)
      && !extractCarrierPickupOrderId(existing.rawResponseExcerpt));
}

function isClientFault(xml: string): boolean {
  return Boolean(extractFault(xml) && /(?:^|:)(?:Client|Sender)$/.test(extractXmlValue(xml, "faultcode")?.trim() ?? ""));
}

function unresolvedPickup(existing?: Partial<StoredCourierPickup>): FulfillmentProviderError {
  const reference = existing?.courierOrderId ?? existing?.id;
  const message = existing?.operatorMessage ?? `Nie potwierdzono stanu rezerwacji ${CARRIER_DISPLAY_NAME}${reference ? ` (${reference})` : ""}. Sprawdź istniejącą próbę przed ponowieniem.`;
  return new FulfillmentProviderError(message, {
    retryable: false,
    supportCode: existing?.supportCode,
    details: classifyCarrierProviderMessage(message) ?? {},
  });
}

async function reconcileExisting(input: {
  client: Client;
  existing: StoredCourierPickup;
  input: BookCourierInput;
  testers: CourierPickupTester[];
  timestamp: string;
  sendEmail?: (id: string, slug: string, source: string) => Promise<unknown>;
}): Promise<BookCourierOutput> {
  const { existing } = input;
  let courierOrderId = existing.courierOrderId;
  if (existing.status === "indeterminate") {
    const rawResponse = existing.rawResponseExcerpt;
    if (!rawResponse || extractFault(rawResponse) || rawResponse.includes("<h1>CException</h1>")) {
      throw unresolvedPickup(existing);
    }
    courierOrderId = extractCarrierPickupOrderId(rawResponse);
    if (!courierOrderId) throw unresolvedPickup(existing);
    await recordCourierPickupShipments(input.client, existing.id, input.testers);
    if (!await recordCourierPickup(input.client, existing.id, "indeterminate", {
      status: "succeeded", courierOrderId, rawResponse,
    })) throw unresolvedPickup({ id: existing.id, courierOrderId });
  }
  if (!courierOrderId) throw unresolvedPickup(existing);
  await throwForFailedReconcile(input.client, input.testers, input.timestamp, input.sendEmail, `Kurier ${CARRIER_DISPLAY_NAME} jest już zamówiony`);
  return formatCarrierPickupBooking({ ...input.input, shipmentsCount: existing.shipmentsCount || input.testers.length, courierOrderId });
}

async function recordProviderFailure(
  client: Client, pickupId: string, timestamp: string, message: unknown, rawResponse: string,
  status: "failed" | "indeterminate",
): Promise<FulfillmentProviderError> {
  const provider = createCarrierProviderEvidence(sanitizeCarrierError(message), timestamp, status === "failed");
  const stored = await recordCourierPickup(client, pickupId, "pending", {
    status,
    rawResponse,
    operatorMessage: provider.operatorMessage,
    retryable: provider.retryable,
    supportCode: provider.supportCode,
  });
  return new FulfillmentProviderError(provider.message, { ...provider, retryable: stored && provider.retryable });
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
