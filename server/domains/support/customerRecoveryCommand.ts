import { SUPPORT_CUSTOMER_360_CONTRACT_VERSION } from "../../../src/domains/support/customer360Contracts.js";
import {
  type CustomerRecoveryCommandRequest,
  type CustomerRecoveryCommandResponse,
  type CustomerRecoveryRefusalCode,
  type OperatorEmailCorrectionRefusalCode,
  type OperatorEmailCorrectionRequest,
  type OperatorEmailCorrectionResponse,
  type OperatorPhoneCorrectionRefusalCode,
  type OperatorPhoneCorrectionRequest,
  type OperatorPhoneCorrectionResponse,
  type OperatorSubscriptionActionKind,
  type OperatorSubscriptionActionPayload,
  type OperatorSubscriptionActionRequest,
  type OperatorSubscriptionActionResponse,
  type OperatorSubscriptionAppliedBy,
  type OperatorSubscriptionRefusalCode,
} from "../../../src/domains/support/customerSupportCommandContracts.js";
import type { OperatorLeadAbsorptionPort } from "./leadAbsorption.js";

export type CustomerRecoveryAuthorityResult =
  | { outcome: "issued"; deliveryStatus: string; auditEventId: string }
  | { outcome: "replayed"; deliveryStatus: string; auditEventId: string }
  | { outcome: "refused"; refusalCode: CustomerRecoveryRefusalCode }
  | { outcome: "conflict"; conflictCode: "idempotency_conflict" };

/**
 * One delegated recovery command against the existing dunning authority.
 *
 * Implementations must atomically reuse that authority's case, durable token
 * hash, notification and audit state. This is intentionally not a token issuer,
 * delivery service or second lifecycle port. Raw token material, URL paths,
 * provider references and payload fingerprints never cross this boundary.
 */
export interface CustomerRecoveryAuthorityPort {
  issueRecovery(input: {
    subjectId: string;
    caseId: string;
    idempotencyKey: string;
    operatorId: string;
  }): Promise<CustomerRecoveryAuthorityResult>;
}

/**
 * One settled operator subscription command.
 *
 * The success arm reports the subscription's own truth after the write, so the
 * console never has to re-read it, and names the rail that performed it. There
 * is no arm for "partly applied": the authority is one transaction.
 */
export type OperatorSubscriptionCommandResult =
  | {
      outcome: "applied" | "noop" | "replayed";
      subscriptionStatus: string;
      nextCycleAt: string | null;
      templateVersion: number;
      eventId: string | null;
      appliedBy: OperatorSubscriptionAppliedBy | null;
    }
  | {
      outcome: "refused" | "conflict";
      refusalCode: OperatorSubscriptionRefusalCode;
    };

export type OperatorEmailCorrectionResult =
  | {
      outcome: "applied" | "noop" | "replayed";
      authUserLinked: boolean;
    }
  | {
      outcome: "refused" | "conflict";
      refusalCode: OperatorEmailCorrectionRefusalCode;
    };

export type OperatorPhoneCorrectionResult = { outcome: "applied" | "noop" | "replayed" }
  | { outcome: "refused" | "conflict"; refusalCode: OperatorPhoneCorrectionRefusalCode };

/**
 * The whole operator command surface support may reach.
 *
 * Implementations must derive the subscriber's authorization principal
 * themselves: no caller supplies it, because a caller that could would be
 * impersonating. Nothing here accepts a payload fingerprint either — the
 * authority computes its own, so a replay cannot be re-labelled from outside.
 *
 * Deliberately absent: cancellation, order-now and package edits. Those move
 * money or need a priced quote lock an operator has nothing to generate from.
 *
 * `absorbLead` joins from ./leadAbsorption.ts rather than being restated here:
 * it is the one command whose whole point is to unblock another one, so it keeps
 * its own module and this surface simply carries it.
 */
export interface CustomerSupportOperatorCommandPort extends CustomerRecoveryAuthorityPort, OperatorLeadAbsorptionPort {
  applySubscriptionAction(input: {
    subscriptionId: string;
    subscriptionAction: OperatorSubscriptionActionKind;
    expectedVersion: number;
    payload: OperatorSubscriptionActionPayload;
    idempotencyKey: string;
    operatorId: string;
  }): Promise<OperatorSubscriptionCommandResult>;
  correctSubjectEmail(input: {
    subjectId: string;
    expectedEmail: string;
    newEmail: string;
    idempotencyKey: string;
    operatorId: string;
  }): Promise<OperatorEmailCorrectionResult>;
  correctSubjectPhone(input: {
    subjectId: string; expectedPhone: string; newPhone: string;
    idempotencyKey: string; operatorId: string;
  }): Promise<OperatorPhoneCorrectionResult>;
}

/**
 * The authority rejected the command's own shape (SQLSTATE 22023). This is a
 * caller fault the route reports as 400, not an upstream outage: retrying the
 * identical body cannot succeed.
 */
export class CustomerSupportCommandInvalidError extends Error {
  constructor() { super("customer_support_operator_command_invalid"); }
}

/**
 * The same idempotency key already settled a *different* command (SQLSTATE
 * 23505). The key is spent; a caller must mint a new one rather than retry.
 */
export class CustomerSupportCommandIdempotencyConflictError extends Error {
  constructor() { super("customer_support_idempotency_conflict"); }
}

/**
 * This deployment has no operator subscription authority at all. Raised by a
 * composition whose migration tree carries no twin of these routines, so that a
 * missing capability is a named refusal instead of a silent success.
 */
export class OperatorSubscriptionAuthorityUnavailableError extends Error {
  constructor() { super("operator_subscription_authority_unavailable"); }
}

export async function executeCustomerRecoveryCommand(input: {
  command: CustomerRecoveryCommandRequest;
  operatorId: string;
  authority: CustomerRecoveryAuthorityPort;
}): Promise<CustomerRecoveryCommandResponse> {
  const { command } = input;
  const result = await input.authority.issueRecovery({
    subjectId: command.subjectId,
    caseId: command.caseId,
    idempotencyKey: command.idempotencyKey,
    operatorId: input.operatorId,
  });
  const base = {
    contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
    action: command.action,
    subjectId: command.subjectId,
    caseId: command.caseId,
  } as const;

  if (result.outcome === "issued") {
    return {
      ...base,
      outcome: "issued",
      replayed: false,
      deliveryStatus: result.deliveryStatus,
      auditEventId: result.auditEventId,
    };
  }
  if (result.outcome === "replayed") {
    return {
      ...base,
      outcome: "replayed",
      replayed: true,
      deliveryStatus: result.deliveryStatus,
      auditEventId: result.auditEventId,
    };
  }
  if (result.outcome === "refused") {
    return {
      ...base,
      outcome: "refused",
      replayed: false,
      refusalCode: result.refusalCode,
    };
  }
  return {
    ...base,
    outcome: "conflict",
    replayed: false,
    conflictCode: result.conflictCode,
  };
}

/**
 * One delegated pause, resume or reschedule.
 *
 * The operator's own principal is the only identity this passes on; the
 * subscriber's is resolved by the authority from the subscription itself.
 */
export async function executeOperatorSubscriptionAction(input: {
  command: OperatorSubscriptionActionRequest;
  operatorId: string;
  authority: CustomerSupportOperatorCommandPort;
}): Promise<OperatorSubscriptionActionResponse> {
  const { command } = input;
  const result = await input.authority.applySubscriptionAction({
    subscriptionId: command.subscriptionId,
    subscriptionAction: command.subscriptionAction,
    expectedVersion: command.expectedVersion,
    payload: command.payload ?? {},
    idempotencyKey: command.idempotencyKey,
    operatorId: input.operatorId,
  });
  const base = {
    contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
    action: command.action,
    subscriptionAction: command.subscriptionAction,
    subscriptionId: command.subscriptionId,
  } as const;

  if ("refusalCode" in result) {
    return { ...base, outcome: result.outcome, refusalCode: result.refusalCode };
  }
  return {
    ...base,
    outcome: result.outcome,
    subscriptionStatus: result.subscriptionStatus,
    nextCycleAt: result.nextCycleAt,
    templateVersion: result.templateVersion,
    eventId: result.eventId,
    appliedBy: result.appliedBy,
  };
}

/**
 * One emergency correction of a mistyped subject address.
 *
 * Only the addresses the operator typed cross this boundary in either
 * direction, so a response can never disclose a stored address the operator had
 * not already supplied as its expectation.
 *
 * `holderId` is the one identifier that crosses outward, and only on the refusal
 * it explains. The caller resolved it before mutating anything - the identity
 * pre-flight has to know who holds the address to decide whether to move the
 * sign-in copy at all - so naming it costs no extra read and turns the commonest
 * refusal from a dead end into the absorption that clears it. An opaque id is not
 * a stored address, so the disclosure rule above still holds.
 */
export async function executeOperatorEmailCorrection(input: {
  command: OperatorEmailCorrectionRequest;
  operatorId: string;
  authority: CustomerSupportOperatorCommandPort;
  holderId?: string | null;
}): Promise<OperatorEmailCorrectionResponse> {
  const { command } = input;
  const result = await input.authority.correctSubjectEmail({
    subjectId: command.subjectId,
    expectedEmail: command.expectedEmail,
    newEmail: command.newEmail,
    idempotencyKey: command.idempotencyKey,
    operatorId: input.operatorId,
  });
  const base = {
    contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
    action: command.action,
    subjectId: command.subjectId,
  } as const;

  if ("refusalCode" in result) {
    return { ...base, outcome: result.outcome, refusalCode: result.refusalCode, holderId: result.refusalCode === "email_already_in_use" ? input.holderId ?? null : null };
  }
  return { ...base, outcome: result.outcome, authUserLinked: result.authUserLinked };
}

/** One correction of the number the fulfillment dispatch carries. Same disclosure
 * rule as the address correction above: only operator-supplied values cross. */
export async function executeOperatorPhoneCorrection(input: {
  command: OperatorPhoneCorrectionRequest;
  operatorId: string;
  authority: CustomerSupportOperatorCommandPort;
}): Promise<OperatorPhoneCorrectionResponse> {
  const { command } = input;
  const result = await input.authority.correctSubjectPhone({
    subjectId: command.subjectId, expectedPhone: command.expectedPhone,
    newPhone: command.newPhone, idempotencyKey: command.idempotencyKey,
    operatorId: input.operatorId,
  });
  const base = {
    contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
    action: command.action, subjectId: command.subjectId,
  } as const;

  if ("refusalCode" in result) {
    return { ...base, outcome: result.outcome, refusalCode: result.refusalCode };
  }
  return { ...base, outcome: result.outcome };
}
