import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  customer360SnapshotResponseSchema,
  type Customer360SnapshotResponse,
} from "./customer360Contracts";
import {
  operatorEmailCorrectionResponseSchema,
  operatorPhoneCorrectionResponseSchema,
  operatorSubscriptionActionResponseSchema,
  type OperatorEmailCorrectionRequest,
  type OperatorEmailCorrectionResponse,
  type OperatorPhoneCorrectionRequest,
  type OperatorPhoneCorrectionResponse,
  type OperatorSubscriptionActionRequest,
  type OperatorSubscriptionActionResponse,
} from "./customerSupportCommandContracts";
import {
  operatorLeadAbsorptionResponseSchema,
  type OperatorLeadAbsorptionRequest,
  type OperatorLeadAbsorptionResponse,
} from "./customerSubjectCorrectionContracts";

const CUSTOMER_JOURNEY_ROUTE = "/api/bff/admin/support/customer-journey";

function bearer(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

/**
 * Fetch one subject's Customer-360 snapshot.
 *
 * `mode` is deliberately not sent: the route treats only an explicit
 * `mode=search` as a candidate lookup, so omitting it selects the snapshot.
 */
export function getCustomer360Snapshot(
  accessToken: string,
  subjectId: string,
  options: BffRequestOptions = {},
): Promise<Customer360SnapshotResponse> {
  return requestBff(
    `${CUSTOMER_JOURNEY_ROUTE}?${new URLSearchParams({ subjectId }).toString()}`,
    customer360SnapshotResponseSchema,
    { ...options, method: "GET", headers: bearer(accessToken, options) },
  );
}

/**
 * Run one pause, resume, reschedule or address change on a subscriber's behalf.
 *
 * `expectedVersion` is the subscription's `templateVersion` as the console last
 * read it: the authority compares it, so an operator and a subscriber editing at
 * the same moment cannot silently overwrite each other. The subscriber's own
 * identity is never sent — the authority resolves it from the subscription.
 *
 * A named business refusal resolves normally with `outcome: "refused"` and a
 * `refusalCode` to render. Only a genuine conflict or outage rejects.
 */
export function applyOperatorSubscriptionAction(
  accessToken: string,
  input: OperatorSubscriptionActionRequest,
  options: BffRequestOptions = {},
): Promise<OperatorSubscriptionActionResponse> {
  return requestBff(
    CUSTOMER_JOURNEY_ROUTE,
    operatorSubscriptionActionResponseSchema,
    { ...options, method: "POST", headers: bearer(accessToken, options), body: input },
  );
}

/**
 * Correct a mistyped subject address. The route moves the authorization copy of the
 * address first, so a linked account is corrected rather than refused; an address
 * another record already holds resolves as `refusalCode: "email_already_in_use"`,
 * and that arm names the holder in `holderId` so the caller can offer to absorb it.
 */
export function correctOperatorSubjectEmail(
  accessToken: string,
  input: OperatorEmailCorrectionRequest,
  options: BffRequestOptions = {},
): Promise<OperatorEmailCorrectionResponse> {
  return requestBff(
    CUSTOMER_JOURNEY_ROUTE,
    operatorEmailCorrectionResponseSchema,
    { ...options, method: "POST", headers: bearer(accessToken, options), body: input },
  );
}

/**
 * Fold a marketing lead into this customer, freeing the address it was holding.
 *
 * The step *before* a correction that was refused, never a substitute for it: this
 * resolves the collision and the correction is then sent again as its own command,
 * so an operator confirms each half and can see the state between them. A lead
 * carrying anything commercial, or a sign-in identity, resolves as
 * `outcome: "refused"` with the reason and the tables that blocked it.
 */
export function absorbOperatorLead(
  accessToken: string,
  input: OperatorLeadAbsorptionRequest,
  options: BffRequestOptions = {},
): Promise<OperatorLeadAbsorptionResponse> {
  return requestBff(
    CUSTOMER_JOURNEY_ROUTE,
    operatorLeadAbsorptionResponseSchema,
    { ...options, method: "POST", headers: bearer(accessToken, options), body: input },
  );
}

/**
 * Correct the number the fulfillment dispatch payload carries. `newPhone` must
 * already be E.164; the console normalizes with the canonical
 * `normalizePhoneToE164` so an operator can paste a national number.
 */
export function correctOperatorSubjectPhone(
  accessToken: string,
  input: OperatorPhoneCorrectionRequest,
  options: BffRequestOptions = {},
): Promise<OperatorPhoneCorrectionResponse> {
  return requestBff(
    CUSTOMER_JOURNEY_ROUTE,
    operatorPhoneCorrectionResponseSchema,
    { ...options, method: "POST", headers: bearer(accessToken, options), body: input },
  );
}
