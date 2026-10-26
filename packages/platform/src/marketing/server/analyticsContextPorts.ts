import type { HttpRequest } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";

/** Host persistence rejects on failure; only literal true means an active context. */
export interface AnalyticsContextPersistencePort {
  syncContext(input: { tokenHash: string; granted: boolean; clientId: string | null }): Promise<unknown>;
  enrollSubscriptions(input: { subject: string; contextHash: string }): Promise<unknown>;
}

export type AnalyticsContextStoreResolver = () => AnalyticsContextPersistencePort | null;

/** The host supplies opaque 32-byte hexadecimal tokens and their cryptographic hash. */
export interface AnalyticsContextCapabilityCrypto {
  mintToken(): string;
  hashToken(token: string): string;
}

export interface AnalyticsContextHandlerDeps {
  respond: BffResponder;
  isEnabled: () => boolean;
  resolveStore: AnalyticsContextStoreResolver;
  readAccessToken: (req: HttpRequest) => string | null;
  resolveTrustedSubject: (accessToken: string) => Promise<string | null>;
  capabilityCrypto: AnalyticsContextCapabilityCrypto;
  cookieName: string;
}
