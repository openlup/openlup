import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createTesterProgramAdminEmailPort,
  buildTesterProgramRewardOutboxHandlers,
  runPublicWaitlistSignupAction,
  runPublicWelcomeEmailAction,
  TESTER_PROGRAM_OUTBOX_MANIFEST_ENTRIES,
  sendStatusEmailInProcess,
} from "./testerProgramEmailBinding.js";

describe("public tester-program email binding", () => {
  it("fails closed without a provider, database, or sent outcome", async () => {
    const port = createTesterProgramAdminEmailPort();

    await expect(port.sendEmail({ recipientId: "tester-1", templateSlug: "welcome" }))
      .rejects.toMatchObject({ name: "CommunicationUnavailableError" });
    await expect(sendStatusEmailInProcess({
      serviceRoleKey: "ignored", testerId: "tester-1", templateSlug: "welcome", source: "test",
      env: {}, fetchImpl: fetch,
    })).resolves.toEqual({
      ok: false,
      status: 503,
      data: { error: "tester_program_email_unavailable" },
    });
    await expect(runPublicWelcomeEmailAction({ email: "lead@example.com" })).resolves.toEqual({
      status: 503,
      body: { error: "public_acquisition_unavailable" },
    });
    await expect(runPublicWaitlistSignupAction({
      email: "lead@example.com", firstName: "Ala", marketingLaunchOfferConsent: true,
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: "public_acquisition_unavailable", code: "public_acquisition_unavailable" },
    });
  });

  it("has no private or provider side-effect dependency", async () => {
    const source = await readFile(new URL("./testerProgramEmailBinding.ts", import.meta.url), "utf8");

    expect(source).not.toContain("/tester-program/");
    expect(source).not.toContain("createResendTransport");
    expect(source).not.toContain("supabase");
    expect(source).not.toContain("src/overlays/");
  });

  it("registers no private reward handler in the public/default binding", () => {
    expect(TESTER_PROGRAM_OUTBOX_MANIFEST_ENTRIES).toEqual([]);
    expect(buildTesterProgramRewardOutboxHandlers({ client: {}, env: {}, platformJobRunId: "run-1" }))
      .toEqual([]);
  });

});
