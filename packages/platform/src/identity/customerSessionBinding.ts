import type { Pool } from "pg";
import type { IdentityJwtLibraryLoader } from "./jwtLibrary.js";
import { createHash, randomBytes } from "node:crypto";
import { createCustomerSessionIssuer } from "./customerSessionIssuer.js";
import {
  createPostgresCustomerChallengeStore,
  type PostgresCustomerChallengeStore,
} from "./postgresCustomerRecovery.js";
import type {
  CustomerChallengeDeliveryPort,
  CustomerChallengeStore,
  CustomerSessionIssuerPort,
} from "./ports.js";
import type { PostgresDataGatewayOptions } from "../data/index.js";
import { resolveBundleId } from "../kernel/index.js";

type Env = Record<string, string | undefined>;

const defaultChallengeStores = new Map<string, PostgresCustomerChallengeStore>();

function sharedChallengeStore(connectionString: string): PostgresCustomerChallengeStore {
  let store = defaultChallengeStores.get(connectionString);
  if (!store) {
    store = createPostgresCustomerChallengeStore({ connectionString });
    defaultChallengeStores.set(connectionString, store);
  }
  return store;
}

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
  /** Releases an owned store/pool; guaranteed no-op for borrowed or shared stores. */
  close?(): Promise<void>;
}

export type PostgresCustomerSessionBindingOptions = {
  issuer: CustomerSessionIssuerPort;
  delivery?: CustomerChallengeDeliveryPort;
  challengeTtlSeconds?: number;
  generateToken?: () => string;
  now?: () => Date;
} & (
  | { store: CustomerChallengeStore; pool?: undefined; connectionString?: undefined; poolFactory?: undefined }
  | { pool: Pool; store?: undefined; connectionString?: undefined; poolFactory?: undefined }
  | { connectionString: string; poolFactory?: PostgresDataGatewayOptions["poolFactory"]; store?: undefined; pool?: undefined }
);

function buildCustomerSessionBinding(input: {
  getStore: () => CustomerChallengeStore;
  closeStore: () => Promise<void>;
  issuer: CustomerSessionIssuerPort;
  delivery: CustomerChallengeDeliveryPort;
  challengeTtlSeconds: number;
  generateToken: () => string;
  now: () => Date;
}): CustomerSessionBinding & { close(): Promise<void> } {
  return {
    async requestChallenge(email) {
      const normalizedEmail = email.trim().toLowerCase();
      const token = input.generateToken();
      const requestedAt = input.now();
      const expiresAt = new Date(requestedAt.getTime() + input.challengeTtlSeconds * 1000).toISOString();
      const store = input.getStore();
      const result = await store.issue({ email: normalizedEmail, tokenHash: hash(token), expiresAt });
      if (result.deliverable) await input.delivery.deliver({ email: normalizedEmail, token, expiresAt });
    },
    async verifyChallenge(token) {
      const store = input.getStore();
      const redeemed = await store.redeem({ tokenHash: hash(token), now: input.now().toISOString() });
      if (!redeemed) return null;
      const session = await input.issuer.issue(redeemed);
      return {
        ...session,
        user: { id: redeemed.principalId, email: redeemed.email },
      };
    },
    close: input.closeStore,
  };
}

/** Env-free direct PostgreSQL customer session binding without per-request pool churn. */
export function createPostgresCustomerSessionBinding(
  options: PostgresCustomerSessionBindingOptions,
): CustomerSessionBinding & { close(): Promise<void> } {
  const challengeTtlSeconds = validateTtl(options.challengeTtlSeconds, 600);
  const delivery = options.delivery ?? createCapturedCustomerChallengeDelivery();
  const generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  const now = options.now ?? (() => new Date());

  if ("store" in options && options.store) {
    const borrowedStore = options.store;
    return buildCustomerSessionBinding({
      getStore: () => borrowedStore,
      closeStore: async () => {},
      issuer: options.issuer,
      delivery,
      challengeTtlSeconds,
      generateToken,
      now,
    });
  }

  if ("pool" in options && options.pool) {
    const borrowedPool = options.pool;
    // Borrowed pool: keep a single store instance and never invoke store.close() / pool.end().
    const store = createPostgresCustomerChallengeStore({ connectionString: "" }, { poolFactory: () => borrowedPool });
    return buildCustomerSessionBinding({
      getStore: () => store,
      closeStore: async () => {},
      issuer: options.issuer,
      delivery,
      challengeTtlSeconds,
      generateToken,
      now,
    });
  }

  const connectionString = options.connectionString?.trim() ?? "";
  if (!connectionString) throw new Error("database_url_required");
  const ownedStore = createPostgresCustomerChallengeStore(
    { connectionString },
    options.poolFactory ? { poolFactory: options.poolFactory } : {},
  );
  let closePromise: Promise<void> | null = null;
  return buildCustomerSessionBinding({
    getStore: () => ownedStore,
    closeStore: () => (closePromise ??= ownedStore.close()),
    issuer: options.issuer,
    delivery,
    challengeTtlSeconds,
    generateToken,
    now,
  });
}

export function resolveCustomerSessionBinding(
  env: Env,
  options: {
    store?: CustomerChallengeStore;
    pool?: Pool;
    createStore?: (connectionString: string) => CustomerChallengeStore & { close(): Promise<void> };
    delivery?: CustomerChallengeDeliveryPort;
    issuer?: CustomerSessionIssuerPort;
    loadJwt?: IdentityJwtLibraryLoader;
    generateToken?: () => string;
    now?: () => Date;
  } = {},
): { binding: CustomerSessionBinding; error?: undefined } | { binding?: undefined; error: string } {
  if (resolveBundleId(env) !== "node-postgres") return { error: "customer_session_external_bundle" };
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!options.store && !options.pool && !connectionString) return { error: "database_url_required" };

  let issuer: CustomerSessionIssuerPort;
  try {
    if (!options.issuer && !options.loadJwt) throw new Error("identity_jwt_library_required");
    issuer = options.issuer ?? createCustomerSessionIssuer({
      audience: env.CUSTOMER_IDENTITY_AUDIENCE ?? "",
      issuer: env.CUSTOMER_IDENTITY_ISSUER ?? "",
      keyId: env.CUSTOMER_IDENTITY_KEY_ID ?? "",
      privateJwk: env.CUSTOMER_IDENTITY_PRIVATE_JWK ?? "",
      ttlSeconds: readTtl(env.CUSTOMER_IDENTITY_SESSION_TTL_SECONDS, 3_600),
    }, options.loadJwt!);
  } catch {
    return { error: "customer_session_issuer_invalid" };
  }

  const delivery = options.delivery ?? createCapturedCustomerChallengeDelivery();
  const generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  const now = options.now ?? (() => new Date());
  const challengeTtlSeconds = readTtl(env.CUSTOMER_IDENTITY_CHALLENGE_TTL_SECONDS, 600);

  if (options.store) {
    return {
      binding: createPostgresCustomerSessionBinding({
        store: options.store,
        issuer,
        delivery,
        challengeTtlSeconds,
        generateToken,
        now,
      }),
    };
  }

  if (options.pool) {
    return {
      binding: createPostgresCustomerSessionBinding({
        pool: options.pool,
        issuer,
        delivery,
        challengeTtlSeconds,
        generateToken,
        now,
      }),
    };
  }

  if (options.createStore) {
    const createStore = options.createStore;
    let lazyStore: (CustomerChallengeStore & { close(): Promise<void> }) | null = null;
    let closePromise: Promise<void> | null = null;
    return {
      binding: buildCustomerSessionBinding({
        getStore: () => (lazyStore ??= createStore(connectionString)),
        closeStore: () => (closePromise ??= lazyStore ? lazyStore.close() : Promise.resolve()),
        issuer,
        delivery,
        challengeTtlSeconds,
        generateToken,
        now,
      }),
    };
  }

  return {
    binding: buildCustomerSessionBinding({
      getStore: () => sharedChallengeStore(connectionString),
      closeStore: async () => {},
      issuer,
      delivery,
      challengeTtlSeconds,
      generateToken,
      now,
    }),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readTtl(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  return validateTtl(Number(value), fallback);
}

function validateTtl(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 300 || value > 86_400) {
    throw new Error("customer identity ttl invalid");
  }
  return value;
}
