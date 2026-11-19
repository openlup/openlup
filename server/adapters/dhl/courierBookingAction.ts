/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query client is structural at this boundary. */
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import {
  buildBookCourierEnvelope,
  callCarrierSoap,
  CARRIER_DISPLAY_NAME,
  CARRIER_NAMESPACE,
  extractCarrierPickupOrderId,
  extractFault,
  sanitizeCarrierError,
  type CarrierAdminAuth,
} from "../../infra/dhl/adminDhlSoap.js";
import { readSoap11Reply } from "../../infra/soap11Reply.js";
import {
  classifyCarrierProviderMessage,
  loadCarrierShipperContact,
  CARRIER_PERSISTENCE,
  createCarrierProviderEvidence,
  createCarrierSupportCode,
  formatCarrierPickupBooking,
  makePickupIdempotencyKey,
  normalizeCarrierPickupIds,
  reconcileShippedTesters,
  type CourierPickupTester,
  validateCarrierPickupTesters,
  validateCarrierPickupWindow,
  pickupStoreUnavailable,
  findCourierPickup,
  recordCourierPickup,
  recordCourierPickupShipments,
  type StoredCourierPickup,
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
    const testerIds = validateInput(input);
    const idempotencyKey = makePickupIdempotencyKey(
      testerIds,
      input.pickupDate,
      input.pickupTimeFrom,
      input.pickupTimeTo,
    );
    const existing = await findCourierPickup(deps.client, idempotencyKey);
    const replay = existing?.status === "succeeded";
    if (existing && (replay ? !existing.confirmedResponse : !canRetryPickup(existing))) throw unresolvedPickup(existing);
    if (!replay) assertPickupWindow(input, now());
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
    try {
      await recordCourierPickupShipments(deps.client, pickupId, testers);
    } catch {
      await recordCourierPickup(deps.client, pickupId, {
        status: "failed", retryEvidence: "not-dispatched", supportCode: createCarrierSupportCode(now(), pickupId),
      });
      throw pickupStoreUnavailable();
    }

    let response: Awaited<ReturnType<typeof callCarrierSoap>>;
    try {
      response = await callCarrierSoap(deps.fetchImpl, "bookCourier", soap);
    } catch (cause) {
      throw await recordProviderFailure(deps.client, pickupId, now(), sanitizeCarrierError(cause), "", "indeterminate");
    }

    const reply = readSoap11Reply(response.text, {
      namespace: CARRIER_NAMESPACE, response: "bookCourierResponse", result: "bookCourierResult",
    });
    const courierOrderId = response.ok && reply?.kind === "accepted" ? reply.ids.join(", ") : null;
    if (!courierOrderId) {
      const fault = extractFault(response.text);
      const cException = response.text.includes("<h1>CException</h1>")
        ? response.text.match(/<p>(.*?)<\/p>/)?.[1] ?? "Server error"
        : null;
      const confirmedRefusal = reply?.kind === "client_refusal" && (response.ok || response.status === 500)
        && !cException && !extractCarrierPickupOrderId(response.text) ? reply.reason : null;
      const status = confirmedRefusal ? "failed" : "indeterminate";
      const message = confirmedRefusal ?? fault ?? cException ?? (response.ok
        ? `${CARRIER_DISPLAY_NAME} nie zwrócił numeru zamówienia kuriera`
        : `${CARRIER_DISPLAY_NAME} HTTP ${response.status}`);
      throw await recordProviderFailure(deps.client, pickupId, now(), message, response.text, status);
    }

    if (!await recordCourierPickup(deps.client, pickupId, {
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

function validateInput(input: BookCourierInput): string[] {
  const { ids, error } = normalizeCarrierPickupIds(input.pickupDate, input.testerIds);
  if (error) throw new FulfillmentPreflightError(error);
  assertPickupWindow(input);
  return ids;
}

function assertPickupWindow(input: BookCourierInput, timestamp?: string) {
  const issue = validateCarrierPickupWindow(input.pickupDate, input.pickupTimeFrom, input.pickupTimeTo, timestamp);
  if (issue) throw new FulfillmentPreflightError(issue);
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
  return existing.retryable && !existing.courierOrderId;
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
  const { courierOrderId } = existing;
  if (!courierOrderId) throw unresolvedPickup(existing);
  const { data, error } = await input.client.from(CARRIER_PERSISTENCE.pickupShipmentTable)
    .select(CARRIER_PERSISTENCE.pickupShipmentSelection).eq(CARRIER_PERSISTENCE.pickupId, existing.id);
  if (error || !Array.isArray(data) || data.length !== input.testers.length
    || !input.testers.every(tester => data.some(row => row.tester_id === tester.id
      && row.tracking_number_snapshot === tester.tracking_number
      && row[CARRIER_PERSISTENCE.shipmentDispatchIdSnapshot] === tester[CARRIER_PERSISTENCE.shipmentDispatchId]
      && row[CARRIER_PERSISTENCE.shipmentDateSnapshot] === tester[CARRIER_PERSISTENCE.shipmentDate]))) {
    throw unresolvedPickup(existing);
  }
  await throwForFailedReconcile(input.client, input.testers, input.timestamp, input.sendEmail, `Kurier ${CARRIER_DISPLAY_NAME} jest już zamówiony`);
  return formatCarrierPickupBooking({ ...input.input, shipmentsCount: existing.shipmentsCount || input.testers.length, courierOrderId });
}

async function recordProviderFailure(
  client: Client, pickupId: string, timestamp: string, message: unknown, rawResponse: string,
  status: "failed" | "indeterminate",
): Promise<FulfillmentProviderError> {
  const provider = createCarrierProviderEvidence(message, timestamp, status === "failed");
  const stored = await recordCourierPickup(client, pickupId, {
    status,
    rawResponse,
    operatorMessage: provider.operatorMessage,
    retryEvidence: provider.retryable ? "carrier-refused" : undefined,
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

async function claimCourierPickup(client: Client, input: {
  idempotencyKey: string;
  request: { pickupDate: string; pickupTimeFrom: string; pickupTimeTo: string; additionalInfo: string };
  requestedBy: string;
  testers: CourierPickupTester[];
  retryOf: Pick<StoredCourierPickup, "id" | "updatedAt"> | null;
}): Promise<string | null> {
  const table = client.from(CARRIER_PERSISTENCE.pickupTable);
  const claim = input.retryOf
    ? table.update({
      status: "pending",
      updated_at: new Date(Math.max(Date.now(), Date.parse(input.retryOf.updatedAt) + 1)).toISOString(),
      requested_by: input.requestedBy,
      additional_info: input.request.additionalInfo || null,
      operator_message: null,
      retryable: null,
      support_code: null,
      raw_response_excerpt: null,
    }).eq("id", input.retryOf.id).eq("status", "failed").eq("retryable", true).eq("updated_at", input.retryOf.updatedAt)
    : table.upsert({
      status: "pending",
      idempotency_key: input.idempotencyKey,
      pickup_date: input.request.pickupDate,
      pickup_time_from: input.request.pickupTimeFrom,
      pickup_time_to: input.request.pickupTimeTo,
      additional_info: input.request.additionalInfo || null,
      requested_by: input.requestedBy,
      shipments_count: input.testers.length,
    }, { onConflict: CARRIER_PERSISTENCE.idempotencyKey, ignoreDuplicates: true });

  const { data, error } = await claim.select("id").maybeSingle();
  if (error || (data != null && typeof data.id !== "string")) throw pickupStoreUnavailable();
  return data?.id ?? null;
}
