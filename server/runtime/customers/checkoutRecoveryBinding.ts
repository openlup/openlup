import { authenticateCustomerUserWith } from "../../_lib/customer-domain/auth.js";
import { createCustomerIdentityVerifier } from "../../adapters/jwt/customerIdentityVerifier.js";
import {
  createPostgresCheckoutRecoveryOrderPort,
  createPostgresCheckoutRecoveryPayService,
  createPostgresCheckoutRecoveryStartPort,
  createPostgresCheckoutRecoveryTokenPort,
} from "../../adapters/postgres/checkoutRecovery.js";
import { createPostgresCustomerRecoveryTransactionLane } from "../../adapters/postgres/dataGateway.js";
import type { PgGatewayClient, PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { readBearerToken } from "../../bff/customers/shared.js";
import type { CheckoutRecoveryStartHandlerDeps } from "../../domains/commerce/checkoutRecoveryStartHandler.js";
import type { CheckoutRecoveryOrderReadPort } from "../../domains/commerce/checkoutRecoveryOrderPort.js";
import type { CheckoutRecoveryPayService } from "../../domains/commerce/checkoutRecoveryPayService.js";
import type { CheckoutRecoveryTokenPort } from "../../domains/commerce/checkoutRecoveryToken.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import { bindRequestActorDataPort } from "../dataBinding.js";

type Env = Record<string, string | undefined>;
type Request = Parameters<typeof readBearerToken>[0];

export function createDirectCheckoutRecoveryStartBinding(
  req: Request,
  recoveryEnabled: () => boolean,
  env: Env = process.env,
): CheckoutRecoveryStartHandlerDeps | null {
  if (resolveBundleId(env) !== "node-postgres") return null;
  const accessToken = readBearerToken(req);
  const gateway = bindRequestActorDataPort("", env);
  if (!gateway) return null;
  const verifier = createCustomerIdentityVerifier({
    audience: env.CUSTOMER_IDENTITY_AUDIENCE ?? "",
    issuer: env.CUSTOMER_IDENTITY_ISSUER ?? "",
    jwks: env.CUSTOMER_IDENTITY_JWKS ?? "",
  });
  let principalId: string | null = null;
  const actor: PgGatewayClient = {
    rpc(name, args) {
      if (!principalId) return Promise.reject(new Error("customer principal unavailable"));
      return gateway.asActor(
        { role: "authenticated", sub: principalId },
        (client) => (client as PgGatewayClient).rpc(name, args),
      );
    },
  } as PgGatewayClient;
  return {
    async authenticateUser() {
      const auth = await authenticateCustomerUserWith(verifier, accessToken);
      if (auth.ok) principalId = auth.userId;
      return auth.ok ? { ok: true, userId: auth.userId } : { ok: false };
    },
    readPort: createPostgresCheckoutRecoveryStartPort(actor),
    tokenPort: createPostgresCheckoutRecoveryTokenPort(actor, actor),
    recoveryEnabled,
  };
}

export interface DirectCheckoutRecoveryContext {
  tokenPort: CheckoutRecoveryTokenPort;
  orderPort: CheckoutRecoveryOrderReadPort;
  payService: CheckoutRecoveryPayService;
}

interface CustomerRecoveryTransactionLane {
  run<T>(work: (client: PgQueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface DirectCheckoutRecoveryBindingDeps {
  createLane?: (options: { connectionString: string }) => CustomerRecoveryTransactionLane;
}

export function resolveDirectCheckoutRecoveryBinding(
  env: Env = process.env,
  deps: DirectCheckoutRecoveryBindingDeps = {},
): { run<T>(work: (context: DirectCheckoutRecoveryContext) => Promise<T>): Promise<T> } | null {
  if (resolveBundleId(env) !== "node-postgres") return null;
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return null;
  return { async run(work) {
    const lane = (deps.createLane ?? createPostgresCustomerRecoveryTransactionLane)({ connectionString });
    let validatedTokenHash: string | null = null;
    const service: PgGatewayClient = {
      rpc(name, args) {
        return lane.run((client) => (client as PgQueryExecutor).query(
          rpcSql(name, args),
          Object.values(args ?? {}),
        )).then(({ rows }) => ({ data: unwrap(rows, name), error: null }));
      },
    } as PgGatewayClient;
    try {
      return await work({
        tokenPort: createPostgresCheckoutRecoveryTokenPort(
          service,
          undefined,
          (value) => { validatedTokenHash = value; },
        ),
        orderPort: createPostgresCheckoutRecoveryOrderPort(service),
        payService: createPostgresCheckoutRecoveryPayService(service, () => validatedTokenHash),
      });
    } finally {
      await lane.close();
    }
  } };
}

function rpcSql(name: string, args: Record<string, unknown> | undefined) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("customer recovery routine invalid");
  const keys = Object.keys(args ?? {});
  if (keys.some((key) => !/^p_[a-z0-9_]+$/.test(key))) throw new Error("customer recovery argument invalid");
  const named = keys.map((key, index) => `"${key}" => $${index + 1}`).join(",");
  return `SELECT public."${name}"(${named}) AS result`;
}

function unwrap(rows: Record<string, unknown>[], name: string) {
  if (rows.length !== 1 || !("result" in rows[0]!)) throw new Error(`${name} response invalid`);
  return rows[0]!.result;
}
