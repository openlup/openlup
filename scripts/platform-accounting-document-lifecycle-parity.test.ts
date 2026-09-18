import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveCapturedDocumentDelivery } from "../server/adapters/captured/accountingDocumentDelivery.js";

const EXPECTATION = "config/platform-accounting-document-lifecycle-parity-expectation.json";
const MIGRATION = "db/platform/migrations/20260812130000_accounting_document_lifecycle_rail.sql";
const COVERAGE = "config/oss-core-capability-coverage.json";
const HARNESS = "platform-accounting-document-lifecycle-parity";
const read = (path: string): string => readFileSync(path, "utf8");
const expectation = () => JSON.parse(read(EXPECTATION)) as {
  transitions: number;
  payload: Record<string, unknown>;
  kernelOnly: Record<string, unknown>;
};

/**
 * The boundary companion for the document lifecycle rail. It asserts the properties that do not
 * need a database, so a defect in them reddens in the cheap lane instead of in the hosted job.
 */
describe("the sealed transport boundary", () => {
  it("refuses an installation that declared no channel, rather than opening by default", () => {
    expect(resolveCapturedDocumentDelivery({}).refused).toBe("document_delivery_channel_undeclared");
    expect(resolveCapturedDocumentDelivery({}).port).toBeUndefined();
  });

  it("refuses a channel it is not, instead of treating any declaration as its own", () => {
    const resolved = resolveCapturedDocumentDelivery({ PLATFORM_DOCUMENT_DELIVERY_CHANNEL: "somebody-elses" });
    expect(resolved.refused).toBe("document_delivery_channel_unsupported");
    expect(resolved.port).toBeUndefined();
  });

  it("opens only on the exact declaration, case and padding forgiven", () => {
    for (const declared of ["captured", "  CAPTURED  "]) {
      expect(resolveCapturedDocumentDelivery({ PLATFORM_DOCUMENT_DELIVERY_CHANNEL: declared }).port).toBeDefined();
    }
  });

  it("hands off deterministically, with no egress and no secret in the reference", async () => {
    const port = resolveCapturedDocumentDelivery({ PLATFORM_DOCUMENT_DELIVERY_CHANNEL: "captured" }).port!;
    const command = { deliveryId: "delivery-1", recipientReference: "recipient-1" };
    const first = await port.deliver(command);
    expect(first.receiptReference).toBe((await port.deliver(command)).receiptReference);
    expect(first.receiptReference).toMatch(/^captured:[0-9a-f]{32}$/);
    expect(first.receiptReference).not.toContain(command.recipientReference);
    expect((await port.deliver({ ...command, deliveryId: "delivery-2" })).receiptReference)
      .not.toBe(first.receiptReference);
  });

  it("refuses a command that names no delivery and one that names no recipient", async () => {
    const port = resolveCapturedDocumentDelivery({ PLATFORM_DOCUMENT_DELIVERY_CHANNEL: "captured" }).port!;
    await expect(port.deliver({ deliveryId: " ", recipientReference: "recipient-1" }))
      .rejects.toThrow("document_delivery_command_invalid");
    await expect(port.deliver({ deliveryId: "delivery-1", recipientReference: "" }))
      .rejects.toThrow("document_delivery_recipient_missing");
  });
});

describe("the committed expectation", () => {
  it("declares exactly the ten compared transitions the wave shipped", () => {
    const committed = expectation();
    expect(committed.transitions).toBe(10);
    expect(Object.keys(committed.payload)).toEqual([
      "D1.a_document_awaiting_the_authority_is_not_offered",
      "D2.an_accepted_submission_offers_the_document",
      "D3.a_rejected_submission_leaves_it_unoffered",
      "D4.a_submission_state_the_ledger_does_not_name_is_refused",
      "D5.without_the_acceptance_requirement_the_same_document_is_offered",
      "D6.a_delivered_document_records_its_receipt",
      "D7.the_same_delivery_again_records_no_second_receipt",
      "D8.a_contradicting_receipt_reference_is_refused",
      "D9.a_failed_attempt_leaves_the_document_undelivered",
      "D10.an_acceptance_the_authority_took_back_closes_the_gate_again",
    ]);
  });

  /**
   * D10 exists because a kernel reading the document's sticky status passed the other nine. If it
   * ever stops pinning both halves of that answer, the hole this wave found reopens silently.
   */
  it("pins D10 as the gate closing again after an acceptance was taken back", () => {
    expect(expectation().payload["D10.an_acceptance_the_authority_took_back_closes_the_gate_again"])
      .toEqual({ offered: 0, documentState: "accepted" });
  });

  it("keeps the coupling comparable on both sides of the one parameter", () => {
    const payload = expectation().payload;
    expect(payload["D1.a_document_awaiting_the_authority_is_not_offered"]).toEqual({ offered: 0 });
    expect(payload["D5.without_the_acceptance_requirement_the_same_document_is_offered"]).toEqual({ offered: 1 });
  });

  it("keeps the five kernel-only probes out of the compared set", () => {
    const committed = expectation();
    expect(Object.keys(committed.kernelOnly)).toHaveLength(5);
    for (const key of Object.keys(committed.kernelOnly)) expect(committed.payload).not.toHaveProperty(key);
  });
});

describe("the neutral forward", () => {
  it("ships no security boundary, matching every forward in this catalogue", () => {
    // Statements only: the header names each of these while explaining why the forward has none.
    const statements = read(MIGRATION).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    for (const forbidden of [/SECURITY DEFINER/i, /\bGRANT\b/i, /\bREVOKE\b/i, /ROW LEVEL SECURITY/i, /CREATE POLICY/i]) {
      expect(statements).not.toMatch(forbidden);
    }
  });

  it("adds both constraints as NOT VALID, so no forward takes a validation lock", () => {
    const sql = read(MIGRATION);
    const added = [...sql.matchAll(/ADD CONSTRAINT[\s\S]*?;/g)].map((match) => match[0]);
    expect(added).toHaveLength(2);
    for (const statement of added) expect(statement).toContain("NOT VALID");
  });

  it("carries no allow-marker of the counted kind", () => {
    expect(read(MIGRATION)).not.toMatch(/[a-z]+:allow-/);
  });
});

/**
 * The owner deferred the counter move on 2026-08-12 (variant B'): the rail ships and no cell banks
 * its evidence. That is a claim about a committed file, so it is asserted rather than described -
 * a later wave that wires a cell up must delete this test deliberately.
 */
describe("the deferred counter move", () => {
  it("leaves no capability cell citing this harness", () => {
    expect(read(COVERAGE)).not.toContain(HARNESS);
  });

  it("leaves the four decision numbers this wave recorded unconsumed", () => {
    for (const decision of ["OD-089", "OD-090", "OD-091", "OD-092"]) {
      expect(read(COVERAGE)).not.toContain(decision);
    }
  });
});
