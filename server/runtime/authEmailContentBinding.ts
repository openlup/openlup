import {
  AuthEmailContentUnavailableError,
  type AuthEmailContentPort,
} from "../domains/auth/ports.js";

/**
 * Public/default Auth-email composition.
 *
 * Product copy is deployment-owned. The portable bundle deliberately exposes
 * no example template, persistence adapter, or provider rail: a signed request
 * that reaches this inactive candidate receives a retryable 503.
 */
export function createAuthEmailContentPort(): AuthEmailContentPort {
  return {
    buildAuthEmailContent() {
      throw new AuthEmailContentUnavailableError();
    },
  };
}
