import { describe, expect, it, vi } from "vitest";
import { operatorLeadAbsorptionResponseSchema } from "../../../src/domains/support/customerSubjectCorrectionContracts.ts";
import { executeOperatorLeadAbsorption, leadAbsorption, type OperatorLeadAbsorptionResult } from "./leadAbsorption.ts";

const CUSTOMER = "0b3e0000-0000-4000-8000-000000000001";
const LEAD = "0b3e0000-0000-4000-8000-000000000002";
const OPERATOR = "0b1e0000-0000-4000-8000-000000000001";
const CARRIED = { personalization: 1, consents: 2, sourceLinks: 1, deliveries: 4 };

const command = {
  action: "absorb_lead",
  subjectId: CUSTOMER,
  leadId: LEAD,
  expectedLeadEmail: "held@example.test",
  idempotencyKey: "absorb-lead-1",
} as const;

function authority(result: OperatorLeadAbsorptionResult) {
  return { absorbLead: vi.fn(async () => result) };
}

describe("reading what the absorption routine answered", () => {
  it.each(["applied", "noop", "replayed"] as const)("keeps what %s carried onto the customer", (outcome) => {
    expect(leadAbsorption({ outcome, action: "absorb_lead", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED }))
      .toEqual({ outcome, leadId: LEAD, customerId: CUSTOMER, carried: CARRIED });
  });

  // The routine may answer in either casing depending on how the lane serializes it;
  // a lane that read only one would drop the counts and report an invalid response
  // for a command that in fact succeeded.
  it("reads the snake-cased shape identically", () => {
    expect(leadAbsorption({
      outcome: "applied", lead_id: LEAD, customer_id: CUSTOMER,
      carried: { personalization: 1, consents: 2, source_links: 1, deliveries: 4 },
    })).toEqual({ outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED });
  });

  /**
   * Every refusal the contract names has to survive the translation. A code this
   * allowlist did not admit would be thrown as an invalid response *after* the
   * command already settled, which is how a stated reason reaches an operator as an
   * anonymous outage - the exact failure the subscription allowlist shipped.
   */
  it.each([
    "lead_not_found", "customer_not_found", "lead_email_expectation_conflict",
    "lead_has_identity", "lead_has_commercial_footprint", "unclassified_referencing_table",
  ] as const)("reports %s as a refusal rather than an outage", (refusalCode) => {
    expect(leadAbsorption({ outcome: "refused", action: "absorb_lead", leadId: LEAD, refusalCode }))
      .toEqual({ outcome: "refused", leadId: LEAD, refusalCode, blockingTables: [] });
  });

  it("carries the blocking tables, de-duplicated, so the refusal names what to classify", () => {
    expect(leadAbsorption({
      outcome: "refused", leadId: LEAD, refusalCode: "unclassified_referencing_table",
      blocking_tables: ["loyalty_points", "loyalty_points", " ", "referral_claims"],
    })).toEqual({
      outcome: "refused", leadId: LEAD, refusalCode: "unclassified_referencing_table",
      blockingTables: ["loyalty_points", "referral_claims"],
    });
  });

  it("treats a spent idempotency key as the modelled conflict arm, reason intact", () => {
    expect(leadAbsorption({ outcome: "conflict", leadId: LEAD, refusalCode: "lead_has_identity" }))
      .toEqual({ outcome: "conflict", leadId: LEAD, refusalCode: "lead_has_identity", blockingTables: [] });
  });

  it.each([
    ["a refusal code nobody has modelled", { outcome: "refused", leadId: LEAD, refusalCode: "lead_smells_wrong" }],
    ["a settled answer with no counts", { outcome: "applied", leadId: LEAD, customerId: CUSTOMER }],
    ["counts that are not whole numbers", { outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: { ...CARRIED, consents: 1.5 } }],
    ["a settled answer naming no customer", { outcome: "applied", leadId: LEAD, carried: CARRIED }],
    ["an outcome this command cannot have", { outcome: "issued", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED }],
    ["no lead at all", { outcome: "applied", customerId: CUSTOMER, carried: CARRIED }],
    ["an array", []],
    ["null", null],
  ])("refuses to invent a result from %s", (_name, value) => {
    expect(() => leadAbsorption(value)).toThrow("customer_support_lead_absorption_response_invalid");
  });

  // Zero is a fact, not an absence: a lead with nothing to carry still absorbed.
  it("keeps an all-zero carry as a success", () => {
    const empty = { personalization: 0, consents: 0, sourceLinks: 0, deliveries: 0 };
    expect(leadAbsorption({ outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: empty }))
      .toEqual({ outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: empty });
  });
});

describe("executing one absorption", () => {
  it("passes exactly the operator's own principal and the command's own ids", async () => {
    const port = authority({ outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED });
    await executeOperatorLeadAbsorption({ command, operatorId: OPERATOR, authority: port });
    expect(port.absorbLead).toHaveBeenCalledWith({
      customerId: CUSTOMER, leadId: LEAD, expectedLeadEmail: "held@example.test",
      idempotencyKey: "absorb-lead-1", operatorId: OPERATOR,
    });
  });

  it("answers a shape the wire contract accepts", async () => {
    const port = authority({ outcome: "applied", leadId: LEAD, customerId: CUSTOMER, carried: CARRIED });
    const response = await executeOperatorLeadAbsorption({ command, operatorId: OPERATOR, authority: port });
    expect(operatorLeadAbsorptionResponseSchema.parse(response)).toEqual({
      contractVersion: "support.customer_360.v2", action: "absorb_lead",
      subjectId: CUSTOMER, leadId: LEAD, outcome: "applied", carried: CARRIED,
    });
  });

  it("keeps a refusal a modelled 200 arm with its reason and blockers", async () => {
    const port = authority({
      outcome: "refused", leadId: LEAD, refusalCode: "lead_has_commercial_footprint",
      blockingTables: ["commerce_orders"],
    });
    const response = await executeOperatorLeadAbsorption({ command, operatorId: OPERATOR, authority: port });
    expect(operatorLeadAbsorptionResponseSchema.parse(response)).toEqual({
      contractVersion: "support.customer_360.v2", action: "absorb_lead",
      subjectId: CUSTOMER, leadId: LEAD, outcome: "refused",
      refusalCode: "lead_has_commercial_footprint", blockingTables: ["commerce_orders"],
    });
  });

  /**
   * The one thing this command must never do quietly. It moves a marketing profile
   * and a consent record onto a person; an answer describing a different pair than
   * the one the operator confirmed is not a success to be rendered.
   */
  it.each([
    ["a different lead", { outcome: "applied", leadId: "someone-else", customerId: CUSTOMER, carried: CARRIED }],
    ["a different customer", { outcome: "applied", leadId: LEAD, customerId: "someone-else", carried: CARRIED }],
    ["a refusal about a different lead", { outcome: "refused", leadId: "someone-else", refusalCode: "lead_not_found", blockingTables: [] }],
  ])("refuses to report a success about %s", async (_name, result) => {
    const port = authority(result as OperatorLeadAbsorptionResult);
    await expect(executeOperatorLeadAbsorption({ command, operatorId: OPERATOR, authority: port }))
      .rejects.toThrow("customer_support_lead_absorption_target_mismatch");
  });
});
