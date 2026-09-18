import { describe, expect, it, vi } from "vitest";
import {
  executeCustomerRecoveryCommand,
  type CustomerRecoveryAuthorityPort,
} from "./customerRecoveryCommand.js";

const command = {
  action: "issue_recovery" as const,
  subjectId: "subject-1",
  caseId: "case-1",
  idempotencyKey: "support-recovery-1",
};

describe("customer recovery command", () => {
  it("delegates to the existing authority and returns only safe evidence", async () => {
    const issueRecovery = vi.fn(async () => ({
      outcome: "issued" as const,
      deliveryStatus: "queued",
      auditEventId: "audit-1",
    }));

    const response = await executeCustomerRecoveryCommand({
      command,
      operatorId: "operator-1",
      authority: { issueRecovery },
    });

    expect(issueRecovery).toHaveBeenCalledWith({
      subjectId: "subject-1",
      caseId: "case-1",
      idempotencyKey: "support-recovery-1",
      operatorId: "operator-1",
    });
    expect(response).toEqual({
      contractVersion: "support.customer_360.v2",
      action: "issue_recovery",
      subjectId: "subject-1",
      caseId: "case-1",
        outcome: "issued" as const,
      replayed: false,
      deliveryStatus: "queued",
      auditEventId: "audit-1",
    });
    expect(JSON.stringify(response)).not.toMatch(/token|hash|url|provider/i);
  });

  it("surfaces replay without causing a second domain call", async () => {
    const authority: CustomerRecoveryAuthorityPort = {
      issueRecovery: vi.fn(async () => ({
        outcome: "replayed" as const,
        deliveryStatus: "delivered",
        auditEventId: "audit-1",
      })),
    };

    const response = await executeCustomerRecoveryCommand({
      command,
      operatorId: "operator-1",
      authority,
    });

    expect(response).toMatchObject({ outcome: "replayed", replayed: true });
    expect(authority.issueRecovery).toHaveBeenCalledTimes(1);
  });

  it.each([
    "lifecycle_not_eligible",
    "dunning_authority_unavailable",
    "case_not_open",
  ] as const)("maps the %s refusal without inventing recovery state", async (refusalCode) => {
    const response = await executeCustomerRecoveryCommand({
      command,
      operatorId: "operator-1",
      authority: {
        issueRecovery: vi.fn(async () => ({ outcome: "refused" as const, refusalCode })),
      },
    });

    expect(response).toMatchObject({ outcome: "refused", replayed: false, refusalCode });
  });

  it("maps a changed-payload replay to a stable conflict", async () => {
    const response = await executeCustomerRecoveryCommand({
      command,
      operatorId: "operator-1",
      authority: {
        issueRecovery: vi.fn(async () => ({
          outcome: "conflict" as const,
          conflictCode: "idempotency_conflict" as const,
        })),
      },
    });

    expect(response).toMatchObject({
      outcome: "conflict",
      replayed: false,
      conflictCode: "idempotency_conflict",
    });
  });
});
