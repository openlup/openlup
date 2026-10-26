import { expect, it, vi } from "vitest";
import { createManagedSurveyResponseSubmit } from "./managedSurveyResponseSubmit.js";

it("binds the existing notification copy and escaping", async () => {
  const deliver = vi.fn(async () => ({ accepted: true, messageId: "mail-1", skip: null, error: null }));
  await createManagedSurveyResponseSubmit({
    gateway: {
      checkRateLimit: async () => "allowed",
      insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
      updateEmailStatus: async () => undefined,
    },
    delivery: {
      evaluatePolicy: async () => ({ allowed: true, reason: "admin_allowed", decisionId: "decision-1" }),
      deliver,
    },
    notifyTo: ["ops@example.invalid"],
    fromEmail: "sender@example.invalid",
    windowMinutes: 60,
    maxPerIp: 20,
    now: () => new Date("2026-08-20T10:00:00.000Z"),
  })({ surveyType: "consumer", responseData: { answer: "<synthetic>" } });
  expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.objectContaining({
    subject: "[Interzoo Survey] New consumer response — 2026-08-20 10:00 UTC",
    html: expect.stringContaining("&lt;synthetic&gt;"),
  }) }));
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({
    html: expect.stringContaining("Interzoo 2026 — new Consumer (B2C) response"),
  }) }));
});
