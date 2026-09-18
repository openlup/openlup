import { SUPPORT_CUSTOMER_360_CONTRACT_VERSION } from "../../../src/domains/support/customer360Contracts.js";
import {
  type LeadAbsorptionCarried,
  type OperatorLeadAbsorptionRefusalCode,
  type OperatorLeadAbsorptionRequest,
  type OperatorLeadAbsorptionResponse,
} from "../../../src/domains/support/customerSubjectCorrectionContracts.js";

/**
 * Folding a marketing lead into the customer who should have had its address.
 *
 * This module holds all three things the two runtimes share: the settled result
 * the authority may report, the port that reports it, and the translation of the
 * routine's own JSON into that result. The translation is here rather than in
 * either adapter on purpose - the managed lane and the node-postgres lane call
 * the same `customer_support_absorb_lead_v1` and must agree on what its answer
 * means, and a second copy of an allowlist is how one lane quietly starts
 * rendering a refusal the other reports.
 */

/**
 * Must stay equal to `operatorLeadAbsorptionRefusalCodeSchema`. A code the
 * authority can produce and this set does not admit is not rendered as a refusal:
 * it is thrown as an invalid response *after* the command already settled, which
 * is how a stated reason reaches an operator as an anonymous 503.
 */
const REFUSALS = new Set<OperatorLeadAbsorptionRefusalCode>([
  "lead_not_found", "customer_not_found", "lead_email_expectation_conflict",
  "lead_has_identity", "lead_has_commercial_footprint", "unclassified_referencing_table",
]);
const SETTLED = new Set(["applied", "noop", "replayed"]);
const CARRIED_KINDS = ["personalization", "consents", "sourceLinks", "deliveries"] as const;

export type OperatorLeadAbsorptionResult =
  | {
      outcome: "applied" | "noop" | "replayed";
      leadId: string;
      customerId: string;
      carried: LeadAbsorptionCarried;
    }
  | {
      outcome: "refused" | "conflict";
      leadId: string;
      refusalCode: OperatorLeadAbsorptionRefusalCode;
      blockingTables: string[];
    };

/**
 * One absorption, settled.
 *
 * `expectedLeadEmail` crosses because it is the optimistic check the operator
 * typed, not a stored value this side may read back. No consent payload, no
 * personalization body and no address of the absorbed record cross in either
 * direction: the counts are what the console needs to say what survived.
 */
export interface OperatorLeadAbsorptionPort {
  absorbLead(input: {
    customerId: string;
    leadId: string;
    expectedLeadEmail: string;
    idempotencyKey: string;
    operatorId: string;
  }): Promise<OperatorLeadAbsorptionResult>;
}

type Row = Record<string, unknown>;

const INVALID = "customer_support_lead_absorption_response_invalid";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Bounded, de-duplicated and order-preserving. The list is rendered verbatim to an
 * operator so they can hand it to whoever classifies the table, so a blank or a
 * repeat in it is noise in the one place the refusal has to be actionable.
 */
function blockingTables(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].slice(0, 200);
}

/**
 * What was carried, or null when the authority did not report it as four
 * non-negative integers. Null is a refusal to guess: reporting "carried nothing"
 * for an answer that simply did not say would tell an operator the campaign
 * attribution was lost when it may well have moved.
 */
function carried(value: unknown): LeadAbsorptionCarried | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row;
  const counts = CARRIED_KINDS.map((kind) => count(row[kind] ?? row[snake(kind)]));
  if (counts.some((entry) => entry === null)) return null;
  const [personalization, consents, sourceLinks, deliveries] = counts as number[];
  return { personalization: personalization!, consents: consents!, sourceLinks: sourceLinks!, deliveries: deliveries! };
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Translate the routine's JSON into the one result shape both lanes report. */
export function leadAbsorption(value: unknown): OperatorLeadAbsorptionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  const row = value as Row;
  const outcome = text(row.outcome);
  const leadId = text(row.leadId ?? row.lead_id);
  if (!leadId) throw new Error(INVALID);

  if (outcome === "refused" || outcome === "conflict") {
    const refusalCode = text(row.refusalCode ?? row.refusal_code) as OperatorLeadAbsorptionRefusalCode;
    if (!REFUSALS.has(refusalCode)) throw new Error(INVALID);
    return { outcome, leadId, refusalCode, blockingTables: blockingTables(row.blockingTables ?? row.blocking_tables) };
  }

  const moved = carried(row.carried);
  const customerId = text(row.customerId ?? row.customer_id);
  if (!SETTLED.has(outcome) || !customerId || !moved) throw new Error(INVALID);
  return { outcome: outcome as "applied" | "noop" | "replayed", leadId, customerId, carried: moved };
}

/**
 * Absorb one lead into one customer, on an operator's explicit instruction.
 *
 * The response echoes the ids the *command* named, and the settled arm first
 * checks that the authority agrees about both. That check is not ceremony: this
 * command destroys nothing but it does move a marketing profile and a consent
 * record onto a different person, and an answer describing a different pair than
 * the one the operator confirmed must never be rendered as a success. A
 * disagreement is an upstream failure by name, not a 400 the caller could fix by
 * retrying, because the identical body would produce the identical mismatch.
 */
export async function executeOperatorLeadAbsorption(input: {
  command: OperatorLeadAbsorptionRequest;
  operatorId: string;
  authority: OperatorLeadAbsorptionPort;
}): Promise<OperatorLeadAbsorptionResponse> {
  const { command } = input;
  const result = await input.authority.absorbLead({
    customerId: command.subjectId,
    leadId: command.leadId,
    expectedLeadEmail: command.expectedLeadEmail,
    idempotencyKey: command.idempotencyKey,
    operatorId: input.operatorId,
  });
  const base = {
    contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
    action: command.action,
    subjectId: command.subjectId,
    leadId: command.leadId,
  } as const;

  if (result.leadId !== command.leadId) throw new Error("customer_support_lead_absorption_target_mismatch");
  if ("refusalCode" in result) {
    return { ...base, outcome: result.outcome, refusalCode: result.refusalCode, blockingTables: result.blockingTables };
  }
  if (result.customerId !== command.subjectId) {
    throw new Error("customer_support_lead_absorption_target_mismatch");
  }
  return { ...base, outcome: result.outcome, carried: result.carried };
}
