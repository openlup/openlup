/** Typed refusal used by public/default composition when product copy is absent. */
export class AuthEmailContentUnavailableError extends Error {
  readonly code = "auth_email_content_unavailable";

  constructor() {
    super("Auth email content unavailable");
    this.name = "AuthEmailContentUnavailableError";
  }
}

