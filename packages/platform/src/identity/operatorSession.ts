import { createHash, randomBytes } from "node:crypto";
import type { CustomerChallengeDeliveryPort, CustomerSessionIssuerPort } from "./ports.js";
import type { OperatorIdentityStore } from "./operatorPorts.js";
import type { OperatorSession } from "./contracts/operatorAuth.js";
export function createOperatorSessionService(options: {
  store: OperatorIdentityStore; delivery: CustomerChallengeDeliveryPort; issuer: CustomerSessionIssuerPort;
  generateToken?: () => string;
  deliveryFailed?: (code: "operator_challenge_delivery_failed") => void;
}) {
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  return {
    /**
     * Issue a challenge, then await the optional acceptance callback before mailbox delivery
     * for every eligibility outcome. Custom HTTP hosts MUST use it to send their padded generic
     * response before transport. Non-HTTP compositions may omit it; this service sends no HTTP
     * responses itself.
     */
    async requestChallenge(email: string, accept?: () => Promise<void>): Promise<void> {
      const token = options.generateToken?.() ?? randomBytes(32).toString("base64url");
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("operator_challenge_generator_invalid");
      const result = await options.store.issue({ email: email.trim().toLowerCase(), tokenHash: hash(token) });
      // Send the generic acceptance before mailbox transport, for every eligibility result.
      await accept?.();
      if (!result.deliverable) return;
      try { await options.delivery.deliver({ email: result.email, expiresAt: result.expiresAt, token }); }
      catch { options.deliveryFailed?.("operator_challenge_delivery_failed"); }
    },
    async verifyChallenge(token: string): Promise<OperatorSession | null> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const identity = await options.store.redeem({ tokenHash: hash(token) });
      if (!identity) return null;
      const session = await options.issuer.issue(identity);
      return { ...session, user: { id: identity.principalId, email: identity.email } };
    },
  };
}
