import {
  CommunicationUnavailableError,
  type CommunicationSendPort,
} from "../../../src/domains/communications/ports.js";
import type { OutboxHandler } from "../../domains/commerce/outboxDispatchContracts.js";

export type StatusEmailResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

export type TesterProgramEmailRuntimeEnv = Record<string, string | undefined>;
/** The published acquisition seam deliberately keeps managed env fields opaque. */
export type PublicClientActionRuntimeEnv = TesterProgramEmailRuntimeEnv;
export type PublicClientActionResponse = {
  success?: boolean;
  skipped?: unknown;
  error?: string;
  code?: string;
};
export type PublicWelcomeEmailRequest = { email: string; website?: string };
export type PublicWelcomeEmailResponse = PublicClientActionResponse;
/**
 * The published seam preserves the required public envelope but intentionally
 * leaves deployment-only profile fields opaque. Its fail-closed runner never
 * reads them; the managed overlay refines them after BFF validation.
 */
export type PublicWaitlistSignupRequest = {
  email: string;
  firstName: string;
  marketingLaunchOfferConsent: boolean;
  [field: string]: unknown;
};
export type PublicWaitlistSignupResponse = {
  success: boolean;
  error?: string;
  code?: string;
};
export type PublicWelcomeEmailRunner = (
  request: PublicWelcomeEmailRequest,
  env?: PublicClientActionRuntimeEnv,
) => Promise<{ status: number; body: PublicWelcomeEmailResponse }>;
export type PublicWaitlistSignupRunner = (
  request: PublicWaitlistSignupRequest,
  env?: PublicClientActionRuntimeEnv,
) => Promise<{ status: number; body: PublicWaitlistSignupResponse }>;
export type TesterProgramEmailCommand = {
  testerId: string;
  templateSlug: string;
  initiator: "admin" | "trusted_machine";
  source?: string;
  outbox?: { eventId: string; platformJobRunId: string; signal: AbortSignal };
};
export type TesterTemplateEmailResult =
  | { kind: "sent"; providerMessageId: string; emailSendId: string | null }
  | { kind: "accepted_without_provider_id"; emailSendId: string | null }
  | {
    kind: "replayed_acceptance"; providerMessageId: string | null; emailSendId: string;
    acceptedWithoutProviderId: boolean;
  }
  | {
    kind: "skipped";
    reason: "sequence_paused" | "already_sent" | "admin_disabled" | "policy_blocked" | "egress_suppressed";
    existingId?: string | null;
    existingProviderMessageId?: string | null;
    policyDecisionId?: string | null;
    policyReason?: string | null;
  }
  | { kind: "race_lost"; orphanProviderMessageId: string | null };
export type TesterTemplateEmailRunner = (
  request: TesterProgramEmailCommand,
  env?: TesterProgramEmailRuntimeEnv,
) => Promise<TesterTemplateEmailResult>;
export type TesterProgramAdminEmailPortOptions = {
  env?: TesterProgramEmailRuntimeEnv;
  sendTesterTemplateEmail?: TesterTemplateEmailRunner;
};
export type StatusEmailInput = {
  serviceRoleKey: string;
  testerId: string;
  templateSlug: string;
  source: string;
  env: TesterProgramEmailRuntimeEnv;
  fetchImpl: typeof fetch;
  sendEmailRunner?: TesterTemplateEmailRunner;
};
export type TesterProgramOutboxManifestEntry = {
  id: string;
  eventTypes: readonly string[];
  readinessIndependentTerminal?: boolean;
  gate(input: {
    client: unknown; env: TesterProgramEmailRuntimeEnv; platformJobRunId: string;
    readiness: { resend: { apiKey?: string }; emailBaseUrl: unknown | null };
  }): boolean;
  build(input: { client: unknown; env: TesterProgramEmailRuntimeEnv; platformJobRunId: string }): OutboxHandler[];
};
export const TESTER_PROGRAM_OUTBOX_MANIFEST_ENTRIES: readonly TesterProgramOutboxManifestEntry[] = [];

/** Public/default acquisition binding: no managed database or provider rail. */
export const runPublicWelcomeEmailAction: PublicWelcomeEmailRunner = async () => ({
  status: 503,
  body: { error: "public_acquisition_unavailable" },
});

/** Public/default acquisition binding: no managed database or provider rail. */
export const runPublicWaitlistSignupAction: PublicWaitlistSignupRunner = async () => ({
  status: 503,
  body: { success: false, error: "public_acquisition_unavailable", code: "public_acquisition_unavailable" },
});

/**
 * Public/default half of the tester-program mail seam. The programme is a
 * private deployment capability, so a published bundle must never contact its
 * provider or database when a caller reaches this binding.
 */
export function createTesterProgramAdminEmailPort(
  _options: TesterProgramAdminEmailPortOptions = {},
): CommunicationSendPort {
  return {
    async sendEmail() {
      throw new CommunicationUnavailableError("Tester-program email is unavailable in this deployment");
    },
  };
}

export async function sendStatusEmailInProcess(_input: StatusEmailInput): Promise<StatusEmailResult> {
  return {
    ok: false,
    status: 503,
    data: { error: "tester_program_email_unavailable" },
  };
}

/** Public deployments know no private tester handler, so the event stays unclaimed. */
export function buildTesterProgramRewardOutboxHandlers(_input: {
  client: unknown; env: TesterProgramEmailRuntimeEnv; platformJobRunId: string;
}): OutboxHandler[] {
  return [];
}
