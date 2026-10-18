// Generic server-side auth ports. OSS core: no provider client, secrets, or
// brand literals. The product app supplies concrete adapters outside this domain.

import type { EmailBlock } from "../../../src/domains/communications/email/blocks.js";
import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";

export type AuthEmailLocale = Locale;

/** Typed refusal used by public/default composition when product copy is absent. */
export class AuthEmailContentUnavailableError extends Error {
  readonly code = "auth_email_content_unavailable";

  constructor() {
    super("Auth email content unavailable");
    this.name = "AuthEmailContentUnavailableError";
  }
}

export interface AuthEmailContentPort {
  buildAuthEmailContent(input: {
    actionType: string;
    userMetadata: Record<string, unknown> | null | undefined;
    redirectTo: string;
    actionLink: string;
    otp: string | null;
  }): {
    locale: AuthEmailLocale;
    subject: string;
    preheader: string;
    blocks: EmailBlock[];
  };
}

export type AuthEmailPersistenceSkipReason = "admin_disabled" | "egress_suppressed";

export interface AuthEmailMessage {
  sender: string;
  recipient: string;
  subject: string;
  html: string;
  text?: string;
}

export interface AuthEmailTransportResult {
  outcome: {
    ok: boolean;
    messageId: string | null;
    providerError: string | null;
    aborted?: boolean;
    adminDisabled?: boolean;
    suppressed?: "drop" | null;
    egressMode?: "production" | "sandbox_direct" | "sandbox_sink" | "drop";
  };
  providerResponse: Record<string, unknown>;
}

/** Provider-neutral outbound seam supplied by the API composition root. */
export interface AuthEmailTransportPort {
  readonly providerKind: string;
  send(message: AuthEmailMessage): Promise<AuthEmailTransportResult>;
}

/** Provider-neutral send observation owned by the Auth email candidate. */
export interface AuthEmailPersistencePort {
  isTemplateEnabled(templateSlug: string, signal: AbortSignal): Promise<boolean>;
  recordSend(input: {
    templateSlug: string;
    recipientEmail: string;
    authUserId: string | null;
    aggregateId: string;
    dedupeKey: string;
    providerKind: string;
    outcome: {
      ok: boolean;
      messageId: string | null;
      providerError: string | null;
      aborted?: boolean;
      skipReason?: AuthEmailPersistenceSkipReason | null;
    };
    providerResponse: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export type { VerifiedPrincipal, IdentityVerifierPort, AdminAuthPort } from "@openlup/platform/identity";
