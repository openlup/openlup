import { createHash, randomBytes } from "node:crypto";
import { createCustomerSessionIssuer } from "../../adapters/jwt/customerSessionIssuer.js";
import { createPostgresCustomerChallengeStore } from "../../adapters/postgres/customerRecovery.js";
import type {
  CustomerChallengeDeliveryPort,
  CustomerChallengeStore,
  CustomerSessionIssuerPort,
} from "../../domains/auth/ports.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;

export type CapturedCustomerChallenge = {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
};

/** Deterministic no-egress reference delivery; deployments inject mail. */
export function createCapturedCustomerChallengeDelivery(
  sink: (challenge: CapturedCustomerChallenge) => Promise<void> = async () => {},
): CustomerChallengeDeliveryPort {
  return { deliver: sink };
}

export interface CustomerSessionBinding {
  requestChallenge(email: string): Promise<void>;
  verifyChallenge(token: string): Promise<{
    accessToken: string;
    expiresAt: string;
    user: { id: string; email: string };
  } | null>;
}

export function resolveCustomerSessionBinding(
  env: Env,
  options: {
    createStore?: (connectionString: string) => CustomerChallengeStore & { close(): Promise<void> };
    delivery?: CustomerChallengeDeliveryPort;
    issuer?: CustomerSessionIssuerPort;
    generateToken?: () => string;
    now?: () => Date;
  } = {},
): { binding: CustomerSessionBinding; error?: undefined } | { binding?: undefined; error: string } {
  if (resolveBundleId(env) !== "node-postgres") return { error: "customer_session_external_bundle" };
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return { error: "database_url_required" };

  let issuer: CustomerSessionIssuerPort;
  try {
    issuer = options.issuer ?? createCustomerSessionIssuer({
      audience: env.CUSTOMER_IDENTITY_AUDIENCE ?? "",
      issuer: env.CUSTOMER_IDENTITY_ISSUER ?? "",
      keyId: env.CUSTOMER_IDENTITY_KEY_ID ?? "",
      privateJwk: env.CUSTOMER_IDENTITY_PRIVATE_JWK ?? "",
      ttlSeconds: readTtl(env.CUSTOMER_IDENTITY_SESSION_TTL_SECONDS, 3_600),
    });
  } catch {
    return { error: "customer_session_issuer_invalid" };
  }

  const createStore = options.createStore ?? ((url) =>
    createPostgresCustomerChallengeStore({ connectionString: url }));
  const delivery = options.delivery ?? createCapturedCustomerChallengeDelivery();
  const generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  const now = options.now ?? (() => new Date());
  const challengeTtlSeconds = readTtl(env.CUSTOMER_IDENTITY_CHALLENGE_TTL_SECONDS, 600);

  return { binding: {
    async requestChallenge(email) {
      const normalizedEmail = email.trim().toLowerCase();
      const token = generateToken();
      const requestedAt = now();
      const expiresAt = new Date(requestedAt.getTime() + challengeTtlSeconds * 1000).toISOString();
      const store = createStore(connectionString);
      try {
        const result = await store.issue({ email: normalizedEmail, tokenHash: hash(token), expiresAt });
        if (result.deliverable) await delivery.deliver({ email: normalizedEmail, token, expiresAt });
      } finally {
        await store.close();
      }
    },
    async verifyChallenge(token) {
      const store = createStore(connectionString);
      try {
        const redeemed = await store.redeem({ tokenHash: hash(token), now: now().toISOString() });
        if (!redeemed) return null;
        const session = await issuer.issue(redeemed);
        return {
          ...session,
          user: { id: redeemed.principalId, email: redeemed.email },
        };
      } finally {
        await store.close();
      }
    },
  } };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readTtl(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 300 || parsed > 86_400) {
    throw new Error("customer identity ttl invalid");
  }
  return parsed;
}
