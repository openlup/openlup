import { expect, it } from "vitest";
import {
  adminClientsPortableSearchRequestSchema,
  customer360LookupRequestSchema,
} from "@openlup/platform/account-support/read-contracts";

it("retains portable defaults, strict fields and the journey lookup requirement", () => {
  expect(adminClientsPortableSearchRequestSchema.parse({ query: " subject-a " }))
    .toEqual({ query: "subject-a", page: 0, pageSize: 10, lifecycleStage: "all" });
  expect(adminClientsPortableSearchRequestSchema.safeParse({ query: "subject-a", extra: true }).success).toBe(false);
  expect(customer360LookupRequestSchema.parse({ subjectId: "subject-a" }))
    .toEqual({ subjectId: "subject-a", pageSize: 10 });
  expect(customer360LookupRequestSchema.safeParse({}).success).toBe(false);
});
