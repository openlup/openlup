import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CustomerMePort } from "../../domains/customers/ports.js";
import {
  DEFAULT_PLATFORM_BUNDLE,
  PLATFORM_BUNDLE_IDS,
} from "../../domains/platform-runtime/platformKernel.js";
import { createCustomerIdentityBinding } from "./customerIdentityBinding.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST = {
  headers: { authorization: "Bearer customer-token" },
} as never;
const MANAGED_BUNDLES = PLATFORM_BUNDLE_IDS.filter(
  (bundle): bundle is Exclude<(typeof PLATFORM_BUNDLE_IDS)[number], "node-postgres"> =>
    bundle !== "node-postgres",
);
if (!MANAGED_BUNDLES.some((bundle) => bundle === DEFAULT_PLATFORM_BUNDLE))
  throw new Error("default customer identity bundle must remain managed");
const ENV = {
  CUSTOMER_IDENTITY_AUDIENCE: "customer-api",
  CUSTOMER_IDENTITY_ISSUER: "https://identity.test",
  CUSTOMER_IDENTITY_JWKS: '{"keys":[]}',
};

describe("customer identity binding", () => {
  it("reuses the bundle-cached direct gateway behind a request-scoped actor-only facade", () => {
    const source = readFileSync(
      "server/runtime/customers/customerIdentityBinding.ts",
      "utf8",
    );

    expect(source).toContain('bindRequestActorDataPort("", env)');
    expect(source).not.toContain("createPostgresDataGateway");
    expect(source).not.toContain("asService");
  });

  it.each(MANAGED_BUNDLES)(
    "keeps %s on the existing managed composition",
    async (bundle) => {
      const managedPort = port(null);
      const client = {};
      const createClient = vi.fn(() => client);
      const authenticate = vi.fn(async () => ({
        ok: true as const,
        userId: USER_ID,
      }));
      const createPort = vi.fn(() => managedPort);
      const binding = createCustomerIdentityBinding(
        REQUEST,
        { PLATFORM_BUNDLE: bundle },
        {
          authenticateManaged: authenticate,
          createManagedClient: createClient as never,
          createManagedPort: createPort as never,
          readManagedEnv: () => ({
            anonKey: "public-key",
            url: "https://identity.test",
          }),
          readToken: () => "customer-token",
        },
      );

      await expect(binding?.authenticateUser(REQUEST)).resolves.toEqual({
        ok: true,
        userId: USER_ID,
      });
      expect(binding?.mePort).toBe(managedPort);
      expect(createClient).toHaveBeenCalledWith(
        { anonKey: "public-key", url: "https://identity.test" },
        "customer-token",
      );
      expect(authenticate).toHaveBeenCalledWith(client, "customer-token");
      expect(createPort).toHaveBeenCalledWith(client);
    },
  );

  it("uses exactly one hard-coded authenticated actor transaction for the direct profile read", async () => {
    const directPort = port(null);
    const gatewayClient = {};
    const asActor = vi.fn(async (_claims, work) => work(gatewayClient));
    const createDirectPort = vi.fn(() => directPort);
    const createVerifier = vi.fn(() => ({
      verifyAccessToken: vi.fn(async () => ({
        email: null,
        emailVerified: false,
        principalId: USER_ID,
      })),
    }));
    const binding = createCustomerIdentityBinding(REQUEST, ENV, {
      createPostgresGateway: () => ({ asActor }),
      createPostgresPort: createDirectPort as never,
      createVerifier,
      resolveBundle: () => "node-postgres",
      readToken: () => "customer-token",
    });

    await expect(binding?.authenticateUser(REQUEST)).resolves.toEqual({
      ok: true,
      userId: USER_ID,
    });
    await expect(binding?.mePort.getCustomerMe(USER_ID)).resolves.toBeNull();
    expect(asActor).toHaveBeenCalledTimes(1);
    expect(asActor).toHaveBeenCalledWith(
      { role: "authenticated", sub: USER_ID },
      expect.any(Function),
    );
    expect("asService" in { asActor }).toBe(false);
    expect(createDirectPort).toHaveBeenCalledWith(gatewayClient);
    expect(createVerifier).toHaveBeenCalledWith({
      audience: ENV.CUSTOMER_IDENTITY_AUDIENCE,
      issuer: ENV.CUSTOMER_IDENTITY_ISSUER,
      jwks: ENV.CUSTOMER_IDENTITY_JWKS,
    });
  });

  it("keeps invalid direct configuration on the existing authentication failure path", async () => {
    const binding = createCustomerIdentityBinding(REQUEST, ENV, {
      createPostgresGateway: () => ({ asActor: vi.fn() }),
      createVerifier: () => {
        throw new Error("invalid identity configuration");
      },
      resolveBundle: () => "node-postgres",
    });

    await expect(binding?.authenticateUser(REQUEST)).rejects.toThrow(
      "invalid identity configuration",
    );
  });

  it("maps a rejected direct token to the existing unauthorized result", async () => {
    const binding = createCustomerIdentityBinding(REQUEST, ENV, {
      createPostgresGateway: () => ({ asActor: vi.fn() }),
      createVerifier: () => ({ verifyAccessToken: vi.fn(async () => null) }),
      resolveBundle: () => "node-postgres",
    });

    await expect(binding?.authenticateUser(REQUEST)).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: "Customer session required",
      ok: false,
    });
  });

  it("refuses a profile id other than the request's verified principal before opening an actor transaction", async () => {
    const asActor = vi.fn();
    const binding = createCustomerIdentityBinding(REQUEST, ENV, {
      createPostgresGateway: () => ({ asActor }),
      createVerifier: () => ({
        verifyAccessToken: vi.fn(async () => ({
          email: null,
          emailVerified: false,
          principalId: USER_ID,
        })),
      }),
      resolveBundle: () => "node-postgres",
    });

    await binding?.authenticateUser(REQUEST);
    await expect(
      binding?.mePort.getCustomerMe("22222222-2222-4222-8222-222222222222"),
    ).rejects.toThrow("customer_principal_mismatch");
    expect(asActor).not.toHaveBeenCalled();
  });
});

function port(result: null): CustomerMePort {
  return { getCustomerMe: vi.fn(async () => result) };
}
