import { vi } from "vitest";
import type { EmailSendResult, EmailTransport } from "../../server/infra/email/emailTransport.js";

export type PublicIntakeEmailOutcomeFixture = {
  ok: boolean;
  messageId: string | null;
  providerError?: string | null;
  suppressed?: "drop" | null;
};

export function publicIntakeEmailResult(input: PublicIntakeEmailOutcomeFixture = { ok: true, messageId: "mail-1" }): EmailSendResult {
  return {
    outcome: { ok: input.ok, resendId: input.messageId, httpStatus: 202, providerError: input.providerError ?? null, aborted: false, suppressed: input.suppressed ?? null },
    providerResponse: { provider_state: "raw_transport_response" },
  };
}

export function publicIntakeEmailTransport(result = publicIntakeEmailResult()): EmailTransport & { send: ReturnType<typeof vi.fn> } {
  return { providerKind: "in-memory", send: vi.fn(async () => result) };
}
