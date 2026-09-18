import { describe, expect, it } from "vitest";
import {
  adminClientsPortableDetailResponseSchema,
  adminClientsPortableSearchResponseSchema,
  adminClientsPortableSummaryResponseSchema,
} from "./portableContracts.js";

describe("portable admin client contracts", () => {
  it("validates search, detail and summary without a managed overlay", () => {
    const subject = {
      subjectId: "subject-1",
      displayName: "Jan Kowalski",
      email: "jan@example.com",
      phone: null,
      lifecycleStage: "customer",
      createdAt: "2026-08-01T10:00:00.000Z",
      lastActivityAt: "2026-08-15T10:00:00.000Z",
    };
    const summary = adminClientsPortableSummaryResponseSchema.safeParse({
      contractVersion: "clients.customer_360.v2",
      summary: {
        totalSubjects: 1,
        byLifecycleStage: { lead: 0, waitlist: 0, tester: 0, customer: 1, inactive: 0 },
        openDunningCases: 1,
        recoverableCases: 1,
        lastActivityAt: "2026-08-15T10:00:00.000Z",
      },
    });
    const search = adminClientsPortableSearchResponseSchema.safeParse({
      contractVersion: "clients.customer_360.v2",
      candidates: [{ subject, matchedBy: "email", confidence: "exact", journeyLookup: { subjectId: "subject-1" } }],
      totalCount: 1,
      page: 0,
      pageSize: 10,
    });
    const detail = adminClientsPortableDetailResponseSchema.safeParse({
      contractVersion: "clients.customer_360.v2",
      subject,
      references: {
        orderIds: ["order-1"],
        subscriptionIds: ["subscription-1"],
        dunningCaseIds: ["case-1"],
      },
      journeyLookup: { subjectId: "subject-1" },
    });

    expect(summary.success).toBe(true);
    expect(search.success).toBe(true);
    expect(detail.success).toBe(true);
    if (!search.success || !detail.success || !summary.success) throw new Error("Expected portable contracts to parse");
    expect(search.data.candidates[0]).not.toHaveProperty("managedOverlay");
    expect(detail.data).not.toHaveProperty("managedOverlay");
    expect(summary.data).not.toHaveProperty("managedOverlay");
  });
});
