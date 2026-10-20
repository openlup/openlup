import { expect, it } from "vitest";
import { createPostgresNotificationRecipientsPort } from "../../src/communications/postgresNotificationRecipients.js";
import { createPostgresConsentEvaluator } from "../../src/communications/postgresConsentEvaluator.js";

it("requires a trusted operator identity and fails closed on missing consent storage", async () => {
  expect(() => createPostgresNotificationRecipientsPort({ connectionString: "postgresql://unused.invalid/synthetic" }, { operatorId: "" })).toThrow();
  const evaluator = createPostgresConsentEvaluator({ connectionString: "postgresql://unused.invalid/synthetic" }, { poolFactory: async () => { throw new Error("synthetic unavailable"); } });
  let sent = false;
  await expect(evaluator.evaluate({ email: "recipient@example.invalid", purpose: "marketing_newsletter" }).then(result => { if (result.allowed) sent = true; })).rejects.toMatchObject({ name: "ConsentEvaluationUnavailableError" });
  expect(sent).toBe(false);
  await expect(evaluator.close()).rejects.toThrow("synthetic unavailable");
});
